"""Portable packager contract tests. Run only in an admitted test job."""
import base64
import copy
import json
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('kit_builder', Path(__file__).with_name('build_kit.py'))
kit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kit)


def inventory(body=b'hello\n'):
    return [{'path': 'a.txt', 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'mode': '100644'}]


def source_archive(body=b'hello\n', extra=None, link=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        row = tarfile.TarInfo('release/a.txt')
        row.size = len(body); row.mode = 0o644
        if link:
            row.type = tarfile.SYMTYPE; row.linkname = 'elsewhere'
            archive.addfile(row)
        else:
            archive.addfile(row, io.BytesIO(body))
        if extra is not None:
            other = tarfile.TarInfo(extra)
            other.type = tarfile.DIRTYPE
            archive.addfile(other)
    return buffer.getvalue()


def one_file_tree(body=b'hello\n'):
    blob = hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).digest()
    raw = b'100644 a.txt\0' + blob
    return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


UI_FILES = {'index.html': b'<!doctype html><p>Invented UI fixture</p>\n',
            'assets/main.js': b'console.log("invented UI fixture");\n'}
UI_REVISION = 'c' * 40
UI_TREE = 'd' * 40


def ui_inventory(files=None):
    files = UI_FILES if files is None else files
    return [{'path': path, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            for path, body in sorted(files.items())]


def ui_archive(variant=None, files=None):
    files = UI_FILES if files is None else files
    prefix = 'other' if variant == 'wrong-prefix' else 'dist'
    entries = [(prefix + '/', b'', tarfile.DIRTYPE, 0o755, 0, 0),
               (prefix + '/assets/', b'', tarfile.DIRTYPE, 0o755, 0, 0)] if files is UI_FILES else [(prefix + '/', b'', tarfile.DIRTYPE, 0o755, 0, 0)]
    for index, (path, original) in enumerate(sorted(files.items())):
        if variant == 'missing' and index == 0:
            continue
        body = (b'X' + original[1:]) if variant == 'tampered' and index == 0 else original
        kind, mode, uid, gid = tarfile.REGTYPE, 0o644, 0, 0
        if index == 0:
            if variant == 'symlink': kind, body = tarfile.SYMTYPE, b''
            if variant == 'hardlink': kind, body = tarfile.LNKTYPE, b''
            if variant == 'fifo': kind, body = tarfile.FIFOTYPE, b''
            if variant == 'suid': mode = 0o4644
            if variant == 'executable': mode = 0o755
            if variant == 'uid': uid = 1000
            if variant == 'gid': gid = 1000
        name = prefix + '/' + path
        if variant == 'file-slash' and index == 0: name += '/'
        entries.append((name, body, kind, mode, uid, gid))
    if variant == 'extra-file': entries.append(('dist/extra.js', b'extra', tarfile.REGTYPE, 0o644, 0, 0))
    if variant == 'extra-directory': entries.append(('dist/unlisted/', b'', tarfile.DIRTYPE, 0o755, 0, 0))
    if variant == 'duplicate-file': entries.append(entries[2])
    if variant == 'duplicate-directory': entries.append(entries[0])
    if variant == 'nonempty-directory': entries[0] = ('dist/', b'hidden', tarfile.DIRTYPE, 0o755, 0, 0)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz', format=tarfile.PAX_FORMAT if variant == 'pax' else tarfile.USTAR_FORMAT) as archive:
        for index, (name, body, kind, mode, uid, gid) in enumerate(entries):
            member = tarfile.TarInfo(name); member.type = kind; member.mode = mode
            member.uid, member.gid, member.size = uid, gid, len(body)
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE): member.linkname = 'index.html'
            if variant == 'pax' and index == 2: member.pax_headers = {'comment': 'hidden metadata'}
            archive.addfile(member, io.BytesIO(body))
    return out.getvalue()


def ui_manifest(files=None):
    files = UI_FILES if files is None else files
    return {'format': 'omegahive.ui-prebuilt/1', 'built_with': 'invented reviewed prebuilt fixture',
            'file_count': len(files), 'files': {row['path']: {'bytes': row['bytes'], 'sha256': row['sha256']}
                                            for row in ui_inventory(files)},
            'source_commit': UI_REVISION, 'source_tree': UI_TREE}


def ui_spec(manifest_raw, archive_raw=b'fixed synthetic archive'):
    return {'archive': {'path': 'payload/ui.tar.gz', 'bytes': len(archive_raw),
                        'sha256': hashlib.sha256(archive_raw).hexdigest()},
            'manifest': {'path': 'payload/ui.manifest.json', 'bytes': len(manifest_raw),
                         'sha256': hashlib.sha256(manifest_raw).hexdigest()},
            'source_revision': UI_REVISION, 'source_tree': UI_TREE}


def release_fixture():
    source = {'path': 'source.tar.gz', 'bytes': 1, 'sha256': 'a' * 64, 'prefix': 'release', 'files': inventory()}
    platform = {name: {'url': 'https://releases.astral.sh/runtime/archive.tar.gz', 'bytes': 1, 'sha256': 'a' * 64}
                for name in ('uv', 'python', 'swipl_source', 'petta_source')}
    platform.update(source_payload=source, core_lock={'path': 'core.lock'}, build_lock={'path': 'build.lock'})
    manifest_raw = json.dumps(ui_manifest(), sort_keys=True).encode()
    return {'schema': 'studio-linux-user-release/2', 'ready': True, 'release_id': 'fixture-release',
            'source_revision': 'a' * 40, 'source_tree': 'b' * 40, 'min_free_bytes': 5 * 1024**3,
            'core_roots': sorted(kit.ROOTS), 'python_version': '3.12.1', 'uv_version': '1.0.0',
            'swipl_version': '9.0.0', 'petta_commit': 'e' * 40, 'ui_prebuilt': ui_spec(manifest_raw),
            'platforms': {'x86_64': platform, 'aarch64': copy.deepcopy(platform)},
            'apps': [{'id': name, 'path': name + '.zip', 'digest': 'sha256:' + 'd' * 64}
                     for name in ('omegaassist', 'omegadesign')],
            'bootstrap': {'helper': {'path': 'seed.py'}, 'seed': {'path': 'seed.json'}},
            'module_files': [], 'default_model': 'openrouter/example/model',
            'embedding_model': 'mock/hash', 'ssh_target': None}



class KitContract(unittest.TestCase):
    def test_disabled_main_refuses_before_file_or_argument_effects(self):
        with patch.object(kit, 'read_exact', side_effect=AssertionError('unexpected read')):
            with patch.object(kit.argparse, 'ArgumentParser', side_effect=AssertionError('unexpected parsing')):
                with self.assertRaisesRegex(kit.Refused, 'build_source_unbound'):
                    kit.main()

    def test_duplicate_and_nonfinite_json_refused(self):
        for body in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}'):
            with self.subTest(body=body), self.assertRaises(kit.Refused):
                kit.strict_json(body)

    def test_member_names_are_relative_and_canonical(self):
        for name in ('/a', '../a', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', 'a\nb', '.'):
            with self.subTest(name=name), self.assertRaises(kit.Refused):
                kit.relative_name(name)
        self.assertEqual(kit.relative_name('payload/a.tar.gz'), 'payload/a.tar.gz')

    def test_pin_rows_reject_bool_duplicates_and_extra_keys(self):
        row = {'path': 'x', 'bytes': 1, 'sha256': 'a' * 64}
        for rows in ([dict(row, bytes=True)], [row, row], [dict(row, owner='sample')]):
            with self.subTest(rows=rows), self.assertRaises(kit.Refused):
                kit.row_map(rows)

    def test_input_pin_is_bounded_before_open(self):
        with patch.object(kit.os, 'open', side_effect=AssertionError('unexpected open')):
            with self.assertRaisesRegex(kit.Refused, 'closed_bounded_input_pin'):
                kit.read_exact(Path('.'), {'path': 'x', 'bytes': kit.COMPRESSED_CAP + 1, 'sha256': 'a' * 64})

    def test_placeholder_release_metadata_refused(self):
        for value in ({'ready': 'UNBOUND'}, ['${revision}'], {'tree': '<tree>'}):
            with self.subTest(value=value), self.assertRaises(kit.Refused):
                kit.no_placeholders(value)

    def test_scrub_policy_checks_platform_paths_and_reviewed_terms(self):
        with self.assertRaises(kit.Refused):
            kit.public_text(bytes((47, 85, 115, 101, 114, 115, 47)) + b'sample/file', [])
        with self.assertRaises(kit.Refused):
            kit.public_text(b'SampleOwner private note', ['sampleowner'])
        kit.public_text(b'Invented release fixture', ['sampleowner'])

    def test_frontend_and_metta_text_screening_is_case_insensitive(self):
        for suffix in ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.html', '.css', '.svg', '.metta'):
            for case in (suffix, suffix.upper()):
                with self.subTest(suffix=case), self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
                    kit.public_file('file' + case, b'SampleOwner', ['sampleowner'])
                with self.subTest(path_suffix=case), self.assertRaisesRegex(kit.Refused, 'private_platform_path_in_public_text'):
                    kit.public_file('file' + case, bytes((47, 85, 115, 101, 114, 115, 47)) + b'sample', [])

    def test_extensionless_and_unknown_utf8_are_screened_without_decoding_binary_fonts(self):
        for name in ('LICENSE', 'frontend.unknown'):
            with self.subTest(name=name), self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
                kit.public_file(name, b'SampleOwner', ['sampleowner'])
        kit.public_file('font.woff2', b'wOF2\0\xff\xfe', ['sampleowner'])
        with self.assertRaises(UnicodeDecodeError):
            kit.public_file('must-be-text.TS', b'\xff\xfe', [])
        with self.assertRaisesRegex(kit.Refused, 'public_file_screen_bound'):
            kit.public_file('large.unknown', b'x' * (8 * 1024**2 + 1), [])

    def test_source_and_app_archive_frontend_files_reach_scrub_screen(self):
        body = b'SampleOwner frontend fixture'
        row = {'path': 'frontend.TS', 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'mode': '100644'}
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            member = tarfile.TarInfo('release/frontend.TS'); member.size = len(body); member.mode = 0o644
            archive.addfile(member, io.BytesIO(body))
        with self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
            kit.inspect_source(buffer.getvalue(), 'release', [row], '0' * 40, ['sampleowner'])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('app/frontend.TS', body)
        with self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
            kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': [row]}, ['sampleowner'])

    def test_official_astral_runtime_host_is_accepted_with_exact_artifact_pin(self):
        release = release_fixture()
        platform = release['platforms']['x86_64']
        source = platform['source_payload']
        refs, payload = kit.references(release)
        self.assertIn('source.tar.gz', refs)
        self.assertEqual(payload, source)
        platform['python']['url'] = 'https://releases.astral.sh/runtime/archive.tar.gz?token=sample'
        with self.assertRaisesRegex(kit.Refused, 'public_runtime_pin_required'):
            kit.references(release)

    def test_github_metadata_rejects_credentials_and_signed_urls(self):
        for url in ('http://github.com/a/b', 'https://token@github.com/a/b',
                    'https://github.com/a/b?token=sample', 'https://github.com/a/b#sample',
                    'https://example.invalid/a/b'):
            with self.subTest(url=url), self.assertRaises(kit.Refused):
                kit.plain_github_url(url)

    def test_source_tree_matches_independent_one_file_tree(self):
        kit.inspect_source(source_archive(), 'release', inventory(), one_file_tree(), [])
        self.assertEqual(kit.git_tree([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904')

    def test_source_links_and_extra_directories_refused(self):
        for raw in (source_archive(link=True), source_archive(extra='release/extra')):
            with self.subTest(size=len(raw)), self.assertRaises(kit.Refused):
                kit.inspect_source(raw, 'release', inventory(), one_file_tree(), [])

    def test_source_wrong_body_mode_and_tree_refused(self):
        for raw, rows, tree in ((source_archive(b'wrong\n'), inventory(), one_file_tree()),
                                (source_archive(), [dict(inventory()[0], mode='100755')], one_file_tree()),
                                (source_archive(), inventory(), 'a' * 40)):
            with self.subTest(tree=tree), self.assertRaises(kit.Refused):
                kit.inspect_source(raw, 'release', rows, tree, [])

    def test_source_directory_payload_and_noncanonical_member_names_refuse(self):
        for name, kind, body in (('release', tarfile.DIRTYPE, b'hidden'),
                                 ('release/a.txt/', tarfile.REGTYPE, b'hello\n')):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
                member = tarfile.TarInfo(name); member.type = kind; member.mode = 0o644
                member.size = len(body); archive.addfile(member, io.BytesIO(body))
            with self.subTest(name=name), self.assertRaises(kit.Refused):
                kit.inspect_source(buffer.getvalue(), 'release', inventory(), one_file_tree(), [])

    def test_app_extra_file_directory_and_symlink_refused(self):
        for kind in ('extra', 'directory', 'link'):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                archive.writestr('app/a.txt', b'hello\n')
                if kind == 'extra':
                    archive.writestr('app/b.txt', b'extra')
                elif kind == 'directory':
                    archive.writestr('app/unlisted/', b'')
                else:
                    row = zipfile.ZipInfo('app/link'); row.create_system = 3
                    row.external_attr = 0o120777 << 16
                    archive.writestr(row, 'a.txt')
            with self.subTest(kind=kind), self.assertRaises(kit.Refused):
                kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': inventory()}, [])

    def test_file_ancestor_inventory_is_refused_in_both_zip_orders(self):
        parent = dict(inventory(b'parent')[0], path='a')
        child = dict(inventory(b'child')[0], path='a/b')
        for rows in ([parent, child], [child, parent]):
            with self.subTest(paths=[r['path'] for r in rows]), self.assertRaisesRegex(kit.Refused, 'source_file_ancestor_collision'):
                kit.source_rows(rows)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                for row in rows:
                    archive.writestr('app/' + row['path'], b'parent' if row['path'] == 'a' else b'child')
            with self.assertRaisesRegex(kit.Refused, 'source_file_ancestor_collision'):
                kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': rows}, [])

    def test_same_path_file_and_directory_are_refused_in_both_orders(self):
        rows = [dict(inventory()[0], path='a')]
        for order in (('app/a', 'app/a/'), ('app/a/', 'app/a')):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                for name in order:
                    archive.writestr(name, b'' if name.endswith('/') else b'hello\n')
            with self.subTest(order=order), self.assertRaises(kit.Refused):
                kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': rows}, [])

    def test_directory_slash_cannot_hide_link_regular_type_or_body(self):
        for mode, body in ((0o120777, b''), (0o100644, b''), (0o40755, b'hidden payload')):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                directory = zipfile.ZipInfo('app/'); directory.create_system = 3
                directory.external_attr = mode << 16
                archive.writestr(directory, body)
                archive.writestr('app/a.txt', b'hello\n')
            with self.subTest(mode=mode), self.assertRaisesRegex(kit.Refused, 'app_directory_type_or_body'):
                kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': inventory()}, [])

    def test_normal_nested_directory_tree_is_accepted(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('app/', b''); archive.writestr('app/nested/', b'')
            archive.writestr('app/nested/a.txt', b'hello\n')
        kit.inspect_app(buffer.getvalue(), {'prefix': 'app/', 'files': [dict(inventory()[0], path='nested/a.txt')]}, [])

    def test_source_inventory_common_5000_boundary_and_one_above(self):
        empty = dict(inventory(b'')[0])
        rows = [dict(empty, path='file-' + str(index)) for index in range(5000)]
        self.assertEqual(len(kit.source_rows(rows)), 5000)
        with self.assertRaisesRegex(kit.Refused, 'source_inventory_required'):
            kit.source_rows(rows + [dict(empty, path='one-extra')])

    def test_explicit_shared_source_prefix_is_exact_and_never_inferred(self):
        self.assertEqual(kit.source_prefix({'prefix': 'release'}, 'release'), 'release')
        for payload, owner in (({}, 'release'), ({'prefix': 'other'}, 'release'),
                               ({'prefix': 'release/'}, 'release'), ({'prefix': 'a/b'}, 'a/b')):
            with self.subTest(payload=payload), self.assertRaises(kit.Refused):
                kit.source_prefix(payload, owner)

    def test_unpinned_locks_and_missing_core_roots_refused(self):
        for body in (b'fastapi\n', b'fastapi==1.0\n', b'--index-url https://example.invalid\n',
                     ('fastapi==1.0 --hash=sha256:' + 'a' * 64 + '\n').encode()):
            with self.subTest(body=body), self.assertRaises(kit.Refused):
                kit.validate_lock(body, core=True)

    def test_wrapper_binds_exact_three_seams_and_preserves_payload(self):
        template = b'ROOT_BOUND_RELEASE=0\nBUNDLE_BYTES=0\nBUNDLE_SHA256=UNBOUND\n' + kit.MARKER
        compressed = gzip.compress(b'byte-identical inner archives', mtime=0)
        script = kit.render_script(template, compressed)
        head, encoded = script.split(kit.MARKER)
        self.assertIn(b'ROOT_BOUND_RELEASE=1\n', head)
        self.assertIn(('BUNDLE_BYTES=' + str(len(compressed)) + '\n').encode(), head)
        self.assertIn(hashlib.sha256(compressed).hexdigest().encode(), head)
        self.assertEqual(base64.b64decode(encoded, validate=False), compressed)
        with self.assertRaises(kit.Refused):
            kit.render_script(template.replace(b'ROOT_BOUND_RELEASE=0\n', b''), compressed)

    def test_incomplete_runtime_release_refused(self):
        with self.assertRaises(kit.Refused):
            kit.references({'schema': 'studio-linux-user-release/2', 'ready': True})


    def test_release_v2_keeps_independent_ui_pins_and_refuses_legacy_node_inputs(self):
        release = release_fixture()
        refs, _ = kit.references(release)
        self.assertNotEqual(release['source_revision'], release['ui_prebuilt']['source_revision'])
        self.assertNotEqual(release['source_tree'], release['ui_prebuilt']['source_tree'])
        self.assertIn(release['ui_prebuilt']['archive']['path'], refs)
        self.assertIn(release['ui_prebuilt']['manifest']['path'], refs)
        self.assertNotIn('node_version', release)
        self.assertTrue(all('node' not in item for item in release['platforms'].values()))
        for variant in ('legacy-node-version', 'legacy-platform-node', 'missing-ui', 'missing-ui-manifest', 'shared-ui-path', 'unhashed-ui'):
            bad = copy.deepcopy(release)
            if variant == 'legacy-node-version': bad['node_version'] = '20.0.0'
            if variant == 'legacy-platform-node': bad['platforms']['x86_64']['node'] = dict(bad['platforms']['x86_64']['uv'])
            if variant == 'missing-ui': del bad['ui_prebuilt']
            if variant == 'missing-ui-manifest': del bad['ui_prebuilt']['manifest']
            if variant == 'shared-ui-path': bad['ui_prebuilt']['manifest']['path'] = bad['ui_prebuilt']['archive']['path']
            if variant == 'unhashed-ui': bad['ui_prebuilt']['archive']['sha256'] = None
            with self.subTest(variant=variant), self.assertRaises(kit.Refused):
                kit.references(bad)

    def test_ui_manifest_maps_exact_raw_owner_keys_without_rewriting_identity(self):
        raw = json.dumps(ui_manifest(), sort_keys=True).encode()
        original = hashlib.sha256(raw).hexdigest()
        rows = kit.inspect_ui_manifest(raw, ui_spec(raw), [])
        self.assertEqual(kit.ui_rows(rows), kit.ui_rows(ui_inventory()))
        self.assertEqual(hashlib.sha256(raw).hexdigest(), original)
        self.assertEqual(ui_spec(raw)['source_revision'], UI_REVISION)
        self.assertEqual(ui_spec(raw)['source_tree'], UI_TREE)

    def test_ui_manifest_refuses_identity_count_shape_and_inventory_changes(self):
        for variant in ('commit', 'tree', 'format', 'count', 'boolean-count', 'files-list', 'extra-key', 'missing-provenance', 'row-extra-key', 'bad-path', 'ancestor'):
            document = ui_manifest()
            if variant == 'commit': document['source_commit'] = '0' * 40
            if variant == 'tree': document['source_tree'] = '0' * 40
            if variant == 'format': document['format'] = 'other/1'
            if variant == 'count': document['file_count'] += 1
            if variant == 'boolean-count': document['file_count'] = True
            if variant == 'files-list': document['files'] = []
            if variant == 'extra-key': document['unexpected'] = 'not admitted'
            if variant == 'missing-provenance': document['built_with'] = ''
            if variant == 'row-extra-key': document['files']['index.html']['mode'] = '100644'
            if variant == 'bad-path': document['files']['../escape'] = document['files'].pop('index.html')
            if variant == 'ancestor':
                document['files']['assets'] = {'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}
                document['file_count'] = len(document['files'])
            raw = json.dumps(document, sort_keys=True).encode()
            with self.subTest(variant=variant), self.assertRaises(kit.Refused):
                kit.inspect_ui_manifest(raw, ui_spec(raw), [])

    def test_ui_inventory_enforces_exact_rows_file_ancestor_and_size_boundaries(self):
        empty = {'path': 'a', 'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}
        self.assertEqual(len(kit.ui_rows([dict(empty, path='f' + str(i)) for i in range(5000)])), 5000)
        self.assertEqual(len(kit.ui_rows([dict(empty, path='f' + str(i), bytes=8 * 1024**2) for i in range(4)])), 4)
        for rows in ([], [dict(empty, bytes=True)], [dict(empty, mode='100644')], [empty, empty],
                     [dict(empty, path='a/b'), empty], [empty, dict(empty, path='a/b')],
                     [dict(empty, bytes=8 * 1024**2 + 1)],
                     [dict(empty, path='f' + str(i), bytes=8 * 1024**2) for i in range(4)] + [dict(empty, path='one-extra', bytes=1)],
                     [dict(empty, path='f' + str(i)) for i in range(5001)]):
            with self.subTest(count=len(rows)), self.assertRaises(kit.Refused):
                kit.ui_rows(rows)

    def test_ui_archive_accepts_exact_dist_and_preserves_raw_tar_bytes(self):
        raw = ui_archive(); before = hashlib.sha256(raw).hexdigest()
        kit.inspect_ui_archive(raw, ui_inventory(), [])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), before)

    def test_ui_archive_refuses_missing_tampered_extra_duplicate_and_link_members(self):
        for variant in ('missing', 'tampered', 'extra-file', 'extra-directory', 'wrong-prefix',
                        'duplicate-file', 'duplicate-directory', 'nonempty-directory',
                        'symlink', 'hardlink', 'fifo', 'file-slash'):
            with self.subTest(variant=variant), self.assertRaises(kit.Refused):
                kit.inspect_ui_archive(ui_archive(variant), ui_inventory(), [])

    def test_ui_archive_refuses_uid_gid_exec_suid_and_pax_header_metadata(self):
        for variant in ('uid', 'gid', 'executable', 'suid', 'pax'):
            with self.subTest(variant=variant), self.assertRaises(kit.Refused):
                kit.inspect_ui_archive(ui_archive(variant), ui_inventory(), [])

    def test_ui_raw_headers_refuse_even_empty_extensions_and_hidden_archive_tails(self):
        expanded = gzip.decompress(ui_archive())
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK, tarfile.GNUTYPE_SPARSE):
            member = tarfile.TarInfo('dist/metadata'); member.type = kind; member.size = 0
            raw = member.tobuf(format=tarfile.USTAR_FORMAT) + expanded
            with self.subTest(extension=kind), self.assertRaises(kit.Refused):
                kit.inspect_ui_archive(gzip.compress(raw, mtime=0), ui_inventory(), [])
        changed_tail = expanded[:-1] + b'X'
        for raw in (changed_tail, expanded + expanded, expanded[:-512] + b'X' * 512):
            with self.subTest(raw_bytes=len(raw)), self.assertRaises(kit.Refused):
                kit.inspect_ui_archive(gzip.compress(raw, mtime=0), ui_inventory(), [])
        member = tarfile.TarInfo('dist/index.html'); body = b'x'; member.size = len(body)
        header = member.tobuf(format=tarfile.USTAR_FORMAT)
        nonzero_padding = header + body + b'X' + bytes(510) + bytes(1024)
        with self.assertRaises(kit.Refused):
            kit.inspect_ui_archive(gzip.compress(nonzero_padding, mtime=0), [{'path': 'index.html', 'bytes': 1, 'sha256': hashlib.sha256(body).hexdigest()}], [])

    def test_ui_expansion_limit_refuses_before_tar_parser(self):
        raw = gzip.compress(bytes(129), mtime=0)
        with patch.object(kit, 'UI_TAR_CAP', 128), patch.object(kit.tarfile, 'open', side_effect=AssertionError('unexpected tar parser')):
            with self.assertRaisesRegex(kit.Refused, 'ui_tar_expansion_cap'):
                kit.inspect_ui_archive(raw, ui_inventory(), [])

    def test_ui_payload_paths_and_manifest_provenance_reach_privacy_screening(self):
        for files in ({'index.html': b'SampleOwner frontend'}, {'assets/SampleOwner.js': b'public frontend'}):
            with self.subTest(paths=sorted(files)), self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
                kit.inspect_ui_archive(ui_archive(files=files), ui_inventory(files), ['sampleowner'])
        document = ui_manifest(); document['built_with'] = 'SampleOwner private provenance'
        raw = json.dumps(document, sort_keys=True).encode()
        with self.assertRaisesRegex(kit.Refused, 'private_term_in_public_text'):
            kit.inspect_ui_manifest(raw, ui_spec(raw), ['sampleowner'])



if __name__ == '__main__':
    unittest.main()
