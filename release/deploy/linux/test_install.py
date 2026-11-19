"""Purpose: verify the public Linux installer's input boundaries and cleanup using synthetic data."""
import copy
from contextlib import ExitStack, redirect_stdout
import ast
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('linux_install_under_test', Path(__file__).with_name('install.py'))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


def row(path, raw=b'', mode='100644'):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'mode': mode}


CODE_TEMPLATE = Path(__file__).with_name('omegacode.service.in').read_text()


def code_record(root):
    """The descriptor's Code service record for a hive root, as Installer.code_service returns it."""
    return {'release': 'e' * 64, 'root': str(root / 'code'), 'config': str(root / 'code/config.json'),
            'repository': str(root / 'repos/small-app'), 'port': 8724}


def catalogue():
    artifact = {'url': 'https://github.com/publisher/releases/download/reviewed/archive.tar.gz',
                'bytes': 1, 'sha256': 'a' * 64}
    platform = {key: dict(artifact) for key in ('uv', 'python', 'swipl_source', 'petta_source')}
    platform['node'] = dict(artifact, url='https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz', version='26.13.0')
    platform.update({key: {'path': 'payload/' + key, 'bytes': 1, 'sha256': 'b' * 64}
                     for key in ('core_lock', 'build_lock', 'source_payload')})
    modules = [row('deploy/linux/' + name) for name in ('install.py', 'control.py', 'serve.py', 'omegahive.service.in', 'omegacode.service.in')]
    platform['source_payload']['files'] = [row('hive/requirements.txt')] + copy.deepcopy(modules)
    platform['source_payload']['prefix'] = 'source-root'
    # Studio (omegadesign), shown as Create, is the release's one app package; the digest is what the e2e tests'
    # program_digest stub returns.
    apps = [{'id': 'omegadesign', 'path': 'payload/omegadesign.zip', 'prefix': 'omegadesign-release/0.4.22/',
             'bytes': 1, 'sha256': '9' * 64, 'digest': 'sha256:' + 'd' * 64,
             'files': [row('plugin.json', b'{}'), row('ui/bundle.lock.json', b'{}')]}]
    return {'schema': 'studio-linux-user-release/2', 'ready': True, 'release_id': 'test-1',
            'source_revision': '1' * 40, 'source_tree': '2' * 40, 'petta_commit': '3' * 40,
            'min_free_bytes': 5 * 1024**3, 'core_roots': sorted(install.CORE_ROOTS),
            'python_version': '3.12.14', 'uv_version': '1.2.3',
            'swipl_version': '10.1.14', 'platforms': {key: copy.deepcopy(platform) for key in ('x86_64', 'aarch64')},
            'apps': apps, 'module_files': modules,
            'ui_prebuilt': {'archive': {'path': 'payload/ui.tar.gz', 'bytes': 1, 'sha256': 'f' * 64},
                'manifest': {'path': 'payload/ui.json', 'bytes': 1, 'sha256': 'e' * 64},
                'source_revision': '4' * 40, 'source_tree': '5' * 40},
            'default_model': 'openrouter/vendor/model', 'embedding_model': 'mock/hash', 'ssh_target': None,
            'bootstrap': {'helper': {'path': 'payload/helper', 'bytes': 1, 'sha256': 'e' * 64}},
            'omega_core': {'path': 'omega-core-abcdef1.bundle', 'bytes': 1, 'sha256': 'c' * 64},
            'code_service': {'path': 'omegacode-309df.tgz', 'bytes': 1, 'sha256': '8' * 64}}


def installed_fixture(home):
    root = home / '.local/share/omegahive'; runtime = root / 'releases/test-1'
    python = runtime / 'venv/bin/python'; control = runtime / 'app/deploy/linux/control.py'
    for path in (python, control):
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'synthetic-never-executed')
    data = root / 'data'; data.mkdir(); (data / 'synthetic-conversation').write_text('owned test data')
    unrelated = root / 'data-keep'; unrelated.mkdir(); (unrelated / 'sentinel').write_text('keep')
    other = root / 'releases/keep-2'; other.mkdir(); (other / 'sentinel').write_text('keep')
    cache = root / 'cache'; cache.mkdir(); (cache / 'sentinel').write_text('keep')
    unit = home / '.config/systemd/user/omegahive.service'; unit.parent.mkdir(parents=True)
    body = b'[Service]\nExecStart=/synthetic/not-run\n'; unit.write_bytes(body)
    shim = home / '.local/bin/omegahive'; shim.parent.mkdir(parents=True); shim.write_text('synthetic shim')
    state = {'schema': 'studio-linux-user-installation/1', 'runtime_root': str(runtime),
        'unit': str(unit), 'unit_sha256': hashlib.sha256(body).hexdigest(), 'python': str(python),
        'control': str(control), 'data_dir': str(data), 'libpython_dir': None}
    statepath = root / 'installation-state.json'; statepath.write_text(json.dumps(state))
    (root / 'runtime.json').write_text('{}')
    return {'root': root, 'runtime': runtime, 'data': data, 'unrelated': unrelated,
            'other_release': other, 'cache': cache, 'unit': unit, 'shim': shim, 'state': statepath}


def tar(path, entries):
    with tarfile.open(path, 'w:gz') as archive:
        for name, raw, link in entries:
            info = tarfile.TarInfo(name)
            if raw is None and link is None:
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif link is not None:
                info.type = tarfile.SYMTYPE; info.linkname = link
                archive.addfile(info)
            else:
                info.size = len(raw); archive.addfile(info, io.BytesIO(raw))


def prebuilt_fixture(root, members=None, manifest_change=None):
    bodies = {'index.html': b'<!doctype html>synthetic UI', 'assets/app.js': b'/* synthetic static asset */'}
    manifest = {'built_with': 'descriptive metadata only; never execute node or npm', 'file_count': len(bodies),
        'files': {name: {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in bodies.items()},
        'format': 'omegahive.ui-prebuilt/1', 'source_commit': '4' * 40, 'source_tree': '5' * 40}
    if manifest_change: manifest_change(manifest)
    mpath = root / 'ui.manifest.json'; mpath.write_text(json.dumps(manifest))
    entries = members if members is not None else [('dist/', None, None), ('dist/assets/', None, None)] + [('dist/' + name, raw, None) for name, raw in bodies.items()]
    archive = root / 'ui.tar.gz'; tar(archive, entries)
    spec = {'archive': {'path': 'ui.tar.gz', 'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()},
        'manifest': {'path': 'ui.manifest.json', 'bytes': mpath.stat().st_size, 'sha256': hashlib.sha256(mpath.read_bytes()).hexdigest()},
        'source_revision': '4' * 40, 'source_tree': '5' * 40}
    return archive, mpath, spec, bodies


def partial_fixture(home):
    instance = install.Installer(home, catalogue(), home)
    instance.root.mkdir(parents=True, mode=0o700)
    (instance.root / 'logs').mkdir(mode=0o700)
    (instance.root / 'releases').mkdir(mode=0o700)
    runtime = instance.root / 'releases/test-1'
    instance.begin_progress(runtime)
    return instance, runtime


class InstallerTests(unittest.TestCase):
    def test_public_release_carries_studio_alone_and_no_obsolete_template_inputs(self):
        value = catalogue()
        install.validate_catalogue(value)
        studio = value['apps'][0]
        for change in ({'apps': [{'id': 'excluded'}]}, {'apps': []}, {'apps': [studio, dict(studio, id='omegaassist')]},
                       {'apps': [dict(studio, id='omegaassist')]}, {'apps': [dict(studio, digest='sha256:short')]},
                       {'apps': [dict(studio, files=[])]},
                       {'bootstrap': dict(value['bootstrap'], seed={'path': 'seed.json'})}):
            candidate = copy.deepcopy(value)
            candidate.update(change)
            with self.assertRaises(install.Refused):
                install.validate_catalogue(candidate)

    def test_downloaded_script_keeps_only_the_required_gui_handoff_context(self):
        script = Path(__file__).with_name('installer.sh').read_text()
        body = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        tree = ast.parse(body)
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'installer_environment')
        # Execute only this exact pure environment mapper, not bootstrap/control/installer work.
        namespace = {}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), '<bootstrap environment mapper>', 'exec'), namespace)
        actual = namespace['installer_environment']({'HOME': '/home/user', 'DISPLAY': ':1',
            'WAYLAND_DISPLAY': 'wayland-0', 'XAUTHORITY': '/home/user/.Xauthority',
            'OPENROUTER_API_KEY': 'secret-not-exported', 'LD_PRELOAD': '/unsafe', 'DBUS_SESSION_BUS_ADDRESS': 'unsafe'})
        self.assertEqual(actual, {'HOME': '/home/user', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'DISPLAY': ':1', 'WAYLAND_DISPLAY': 'wayland-0', 'XAUTHORITY': '/home/user/.Xauthority'})
        self.assertIn('unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME', script)

    def test_unpublished_catalogue_refuses_before_any_setup(self):
        value = catalogue(); value['ready'] = False
        with patch.object(install.subprocess, 'Popen') as spawn, self.assertRaises(install.Refused):
            install.validate_catalogue(value)
        spawn.assert_not_called()

    def test_six_hive_roots_accept_without_root_ml_dependencies(self):
        value = catalogue()
        self.assertIs(install.validate_catalogue(value), value)
        value['core_roots'].append('torch')
        with self.assertRaises(install.Refused): install.validate_catalogue(value)

    def test_mock_llm_and_ambient_model_placeholders_refuse(self):
        for selected in ('mock', 'mock/free', '${OPENROUTER_API_KEY}', 'openrouter/'):
            with self.subTest(selected=selected):
                value = catalogue(); value['default_model'] = selected
                with self.assertRaises(install.Refused): install.validate_catalogue(value)

    def test_unpinned_or_private_download_destination_refuses(self):
        for change in ({'sha256': None}, {'url': 'https://user:secret@github.com/a'},
                       {'url': 'file:///etc/passwd'}, {'url': 'https://unreviewed.invalid/a'}):
            with self.subTest(change=change):
                value = catalogue(); value['platforms']['x86_64']['python'].update(change)
                with self.assertRaises(install.Refused): install.validate_catalogue(value)

    def test_exact_astral_release_host_still_requires_https_pin_and_no_credentials(self):
        value = catalogue()
        value['platforms']['x86_64']['uv']['url'] = 'https://releases.astral.sh/synthetic/uv.tar.gz'
        self.assertIs(install.validate_catalogue(value), value)
        for url in ('http://releases.astral.sh/synthetic/uv.tar.gz',
                    'https://releases.astral.sh.evil.invalid/synthetic/uv.tar.gz',
                    'https://user:synthetic-secret@releases.astral.sh/synthetic/uv.tar.gz',
                    'https://releases.astral.sh/synthetic/uv.tar.gz?token=synthetic'):
            with self.subTest(url=url):
                changed = copy.deepcopy(value); changed['platforms']['x86_64']['uv']['url'] = url
                with self.assertRaises(install.Refused): install.validate_catalogue(changed)
        changed = copy.deepcopy(value); changed['platforms']['x86_64']['uv']['sha256'] = None
        with self.assertRaises(install.Refused): install.validate_catalogue(changed)

    def test_module_rows_must_join_source_vector_before_any_setup(self):
        value = catalogue(); value['module_files'][0]['sha256'] = 'f' * 64
        with patch.object(install.subprocess, 'Popen') as spawn, self.assertRaises(install.Refused):
            install.validate_catalogue(value)
        spawn.assert_not_called()

    def test_lock_requires_all_six_roots_janus_and_hashes(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'requirements.lock'
            valid = ''.join(package + '==1.0 --hash=sha256:' + 'a' * 64 + '\n' for package in sorted(install.CORE_ROOTS | {'janus-swi'}))
            path.write_text(valid)
            self.assertEqual(install.validate_lock(path, core=True), install.CORE_ROOTS | {'janus-swi'})
            for raw in (valid.replace('--hash=sha256:' + 'a' * 64, ''),
                        valid + '--extra-index-url https://unreviewed.invalid\n',
                        valid.replace('janus-swi==1.0 --hash=sha256:' + 'a' * 64 + '\n', '')):
                path.write_text(raw)
                with self.assertRaises(install.Refused): install.validate_lock(path, core=True)

    def test_json_duplicate_and_nonfinite_values_refuse(self):
        for raw in ('{"ready":true,"ready":false}', '{"bytes":NaN}'):
            with self.assertRaises(install.Refused): install.strict_json(raw)

    def test_source_exact_inventory_accepts_explicit_empty_files(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tgz'; out = root / 'out'
            tar(archive, [('source-root/', None, None), ('source-root/hive/', None, None),
                          ('source-root/hive/empty.py', b'', None), ('source-root/hive/main.py', b'print(1)\n', None)])
            install.extract_source(archive, out, [row('hive/empty.py'), row('hive/main.py', b'print(1)\n')], 'source-root')
            self.assertEqual((out / 'hive/empty.py').read_bytes(), b'')
            self.assertEqual((out / 'hive/main.py').read_bytes(), b'print(1)\n')

    def test_source_escape_link_and_unlisted_body_refuse(self):
        for entry in [('../escape', b'bad', None), ('hive/known.py', b'', '/etc/passwd'), ('hive/extra.py', b'bad', None)]:
            with self.subTest(entry=entry), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive = root / 'source.tgz'; tar(archive, [('source-root/' + entry[0], entry[1], entry[2])])
                with self.assertRaises(install.Refused):
                    install.extract_source(archive, root / 'out', [row('hive/known.py')], 'source-root')
                self.assertFalse((root / 'escape').exists())

    def test_source_prefix_is_explicit_single_and_shared_across_platforms(self):
        for prefix in (None, '', '.', 'source-root/', 'one/two', '../root'):
            with self.subTest(prefix=prefix):
                value = catalogue(); value['platforms']['x86_64']['source_payload']['prefix'] = prefix
                with self.assertRaises(install.Refused): install.validate_catalogue(value)
        value = catalogue(); value['platforms']['aarch64']['source_payload']['prefix'] = 'different-root'
        with self.assertRaises(install.Refused): install.validate_catalogue(value)

    def test_wrong_source_prefix_refuses_without_inference_or_repack(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tgz'
            tar(archive, [('actual-root/hive/main.py', b'pass', None)])
            original = archive.read_bytes()
            with self.assertRaises(install.Refused):
                install.extract_source(archive, root / 'out', [row('hive/main.py', b'pass')], 'reviewed-root')
            self.assertEqual(archive.read_bytes(), original)
            self.assertFalse((root / 'out/hive/main.py').exists())

    def test_prefixed_source_writes_root_relative_module_paths_and_keeps_tar_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tgz'; out = root / 'out'
            tar(archive, [('source-root/deploy/linux/install.py', b'reviewed-source', None)])
            original = archive.read_bytes()
            install.extract_source(archive, out, [row('deploy/linux/install.py', b'reviewed-source')], 'source-root')
            self.assertEqual((out / 'deploy/linux/install.py').read_bytes(), b'reviewed-source')
            self.assertFalse((out / 'source-root').exists())
            self.assertEqual(archive.read_bytes(), original)

    def test_source_rejects_extra_directory_duplicate_path_and_nonempty_directory(self):
        for entries in [
                [('source-root/extra/', None, None), ('source-root/a', b'a', None)],
                [('source-root/a', b'a', None), ('source-root/a', b'a', None)],
                [('source-root/a/', None, None), ('source-root/a', b'a', None)]]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive = root / 'source.tgz'; tar(archive, entries)
                with self.assertRaises(install.Refused):
                    install.extract_source(archive, root / 'out', [row('a', b'a')], 'source-root')
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tgz'
            with tarfile.open(archive, 'w:gz') as out:
                info = tarfile.TarInfo('source-root/'); info.type = tarfile.DIRTYPE; info.size = 1
                out.addfile(info, io.BytesIO(b'x'))
            with self.assertRaises(install.Refused):
                install.extract_source(archive, root / 'out', [row('a', b'a')], 'source-root')

    def test_file_ancestor_inventory_collisions_refuse_in_both_orders(self):
        for rows in ([row('a', b'a'), row('a/b', b'b')], [row('a/b', b'b'), row('a', b'a')]):
            with self.subTest(rows=rows), self.assertRaises(install.Refused): install.checked_members(rows)

    def test_app_directory_entries_cannot_hide_links_data_or_file_collisions(self):
        for kind, raw, dirname in [(0o120777, b'', 'app/1/'), (0o40755, b'not-empty', 'app/1/'),
                                    (0o40755, b'', 'app/1/plugin.json/')]:
            with self.subTest(kind=kind, raw=raw, dirname=dirname), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive = root / 'app.zip'
                with zipfile.ZipFile(archive, 'w') as out:
                    info = zipfile.ZipInfo(dirname); info.create_system = 3; info.external_attr = kind << 16
                    out.writestr(info, raw); out.writestr('app/1/plugin.json', '{}')
                with self.assertRaises(install.Refused):
                    install.extract_app(archive, root / 'out', {'prefix': 'app/1/', 'files': [row('plugin.json', b'{}')]})

    def test_app_declared_nested_directories_and_regular_files_still_materialize(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'app.zip'; out = root / 'out'
            with zipfile.ZipFile(archive, 'w') as zipped:
                for dirname in ('app/1/', 'app/1/ui/'):
                    info = zipfile.ZipInfo(dirname); info.create_system = 3; info.external_attr = 0o40755 << 16
                    zipped.writestr(info, b'')
                zipped.writestr('app/1/plugin.json', '{}'); zipped.writestr('app/1/ui/style.css', 'body{}')
            install.extract_app(archive, out, {'prefix': 'app/1/',
                'files': [row('plugin.json', b'{}'), row('ui/style.css', b'body{}')]})
            self.assertEqual((out / 'plugin.json').read_bytes(), b'{}')
            self.assertEqual((out / 'ui/style.css').read_bytes(), b'body{}')

    def test_vendor_link_cannot_leave_runtime(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'tool.tgz'
            tar(archive, [('vendor/bin/tool', b'', '../../../escape')])
            with self.assertRaises(install.Refused): install.extract_tool(archive, root / 'runtime')

    def test_vendor_mixed_archive_roots_refuse(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'tool.tgz'
            tar(archive, [('first/bin/tool', b'a', None), ('second/lib/data', b'b', None)])
            with self.assertRaises(install.Refused): install.extract_tool(archive, root / 'runtime')

    def test_app_zip_exact_members_and_hashes_are_required(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'app.zip'
            with zipfile.ZipFile(archive, 'w') as out:
                out.writestr('app/1/plugin.json', '{}'); out.writestr('app/1/unreviewed.py', 'pass')
            app = {'prefix': 'app/1/', 'files': [row('plugin.json', b'{}')]}
            with self.assertRaises(install.Refused): install.extract_app(archive, root / 'out', app)

    def test_program_digest_covers_source_and_ui_lock_without_a_walk(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); (root / 'ui').mkdir()
            source = [('plugin.json', b'{}'), ('program.py', b'pass'), ('ui/bundle.lock.json', b'one')]
            for path, raw in source: (root / path).write_bytes(raw)
            rows = [row(path, raw) for path, raw in source]
            expected = hashlib.sha256(b'plugin.json\0{}\0program.py\0pass\0ui/bundle.lock.json\0one\0').hexdigest()
            self.assertEqual(install.program_digest(root, rows), 'sha256:' + expected)
            (root / 'ui/bundle.lock.json').write_bytes(b'two')
            self.assertNotEqual(install.program_digest(root, rows), 'sha256:' + expected)

    def test_changed_local_payload_fails_before_apt(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); file = root / 'payload'; file.write_bytes(b'changed')
            with self.assertRaises(install.Refused): install.pin_file(file, row('payload', b'original'))

    def apt_commands(self, restricted, uid=1002, update_failures=()):
        """The apt step's privileged commands and the profile file it wrote, on a host restricted or not, each of
        update_failures being the status the next apt-get update fails with; the pauses between attempts are listed."""
        with tempfile.TemporaryDirectory() as name:
            runtime = Path(name).resolve() / 'releases/test-1'; runtime.mkdir(parents=True)
            commands, failures, pauses = [], list(update_failures), []
            instance = install.Installer(Path('/unused'), {}, Path(name).resolve() / 'home')
            def sudo(argv, **kwargs):
                commands.append((argv, kwargs))
                if argv[-1] == 'update' and failures:
                    raise install.CommandFailed('Setup command failed (status %d).' % failures[0], failures.pop(0))
            instance.sudo = sudo
            with patch.object(install, 'linger_user', return_value='fresh-user'), \
                 patch.object(install, 'userns_restricted', return_value=restricted), \
                 patch.object(install, 'apparmor_enabled', return_value=True), \
                 patch.object(install, 'pause', side_effect=pauses.append), \
                 patch.object(install.os, 'getuid', return_value=uid):
                self.assertEqual(instance.apt(runtime), restricted)
            source = runtime / 'omegahive.apparmor'
            self.assertEqual(pauses, [install.APT_UPDATE_PAUSE] * (len(update_failures) - len(failures)))
            return commands, source.read_text(), source.stat().st_mode & 0o777, source, instance.root

    def test_apt_update_runs_again_only_after_apts_own_error_status(self):
        # A server publishing updates can serve mismatched package lists (apt-get update exits 100): the update runs
        # again a minute later and setup goes on. sudo's own failure (1) or a third 100 stops setup as before.
        commands = self.apt_commands(False, update_failures=(100, 100))[0]
        self.assertEqual([argv[-1] for argv, _kwargs in commands[:4]], ['update', 'update', 'update', install.APT[-1]])
        for statuses in ((1,), (100,) * install.APT_UPDATE_ATTEMPTS):
            with self.subTest(statuses=statuses), self.assertRaises(install.CommandFailed) as failed:
                self.apt_commands(False, update_failures=statuses)
            self.assertEqual(failed.exception.status, statuses[-1])

    def test_a_failed_command_carries_its_own_exit_status(self):
        instance = install.Installer(Path('/unused'), {}, Path.home())
        with tempfile.TemporaryFile() as log:
            instance.log = log
            with self.assertRaises(install.CommandFailed) as failed:
                instance.run([install.sys.executable, '-I', '-c', 'raise SystemExit(100)'])
        self.assertEqual(failed.exception.status, 100)
        self.assertIsInstance(failed.exception, install.Refused)
        self.assertIn('(status 100)', str(failed.exception))

    def test_apt_uses_five_fixed_privileged_commands_and_loads_the_code_profile_on_every_release(self):
        for restricted in (False, True):
            with self.subTest(restricted=restricted):
                commands, text, mode, source, root = self.apt_commands(restricted)
                target = '/etc/apparmor.d/omegahive-1002'
                wait = ['/usr/bin/apt-get', '-o', 'DPkg::Lock::Timeout=' + str(install.APT_LOCK_WAIT)]
                keep = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']
                # No deadline of the installer's own: apt bounds the lock and a silent server, and dpkg asks nothing.
                self.assertEqual(commands[0], ([*wait, 'update'], {'timeout': None}))
                self.assertEqual(commands[1], ([*wait, *keep, 'install', '-y', '--no-install-recommends', *install.APT],
                                               {'timeout': None, 'package_environment': True}))
                self.assertEqual([argv for argv, _kwargs in commands[2:]], [
                    ['/usr/bin/loginctl', 'enable-linger', 'fresh-user'],
                    ['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', str(source), target],
                    [install.APPARMOR_PARSER, '-r', target]])
                self.assertIn('apparmor', install.APT); self.assertIn('patch', install.APT)
                self.assertTrue(text.startswith('# Purpose: '))
                self.assertIn('abi <abi/' + ('4.0' if restricted else '3.0') + '>,\ninclude <tunables/global>\n', text)
                self.assertIn('profile omegahive-code-1002 flags=(attach_disconnected) {', text)
                for rule in ('  ' + str(root / 'code') + '/{state,tmp,wd,home}/** rwlk,', '  ' + str(root / 'repos/small-app') + '/** rwlk,',
                             '  ptrace (readby) peer=unconfined,', '  signal (receive) peer=unconfined,'):
                    self.assertIn(rule, text)
                self.assertEqual('profile omegahive-mind-launcher-1002 ' in text, restricted)
                self.assertEqual(mode, 0o600)

    def test_apt_refuses_where_apparmor_is_off_before_any_prompt(self):
        with tempfile.TemporaryDirectory() as name:
            runtime = Path(name).resolve() / 'releases/test-1'; runtime.mkdir(parents=True)
            commands = []
            instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
            instance.sudo = lambda argv, **kwargs: commands.append(argv)
            with patch.object(install, 'apparmor_enabled', return_value=False), \
                 self.assertRaisesRegex(install.Refused, 'AppArmor'):
                instance.apt(runtime)
            self.assertEqual(commands, [])
            self.assertFalse((runtime / 'omegahive.apparmor').exists())

    def test_restricted_host_profile_file_carries_the_exact_launcher_profile(self):
        _commands, text, _mode, source, _root = self.apt_commands(True)
        launcher = source.parent / 'app/hive/supervisor/landlock.py'
        self.assertIn('profile omegahive-mind-launcher-1002 ' + str(launcher) + ' flags=(unconfined) {\n  userns,\n', text)
        self.assertIn('include if exists <local/omegahive-mind-launcher-1002>', text)

    def test_unplain_launcher_path_stops_before_any_password_prompt(self):
        with tempfile.TemporaryDirectory() as name:
            runtime = Path(name).resolve() / 'release {one}'; runtime.mkdir()
            commands = []
            instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
            instance.sudo = lambda argv, **kwargs: commands.append(argv)
            with patch.object(install, 'userns_restricted', return_value=True), \
                 patch.object(install, 'apparmor_enabled', return_value=True), \
                 self.assertRaisesRegex(install.Refused, 'installation path can use only'):
                instance.apt(runtime)
            self.assertEqual(commands, [])
            self.assertFalse((runtime / 'omegahive.apparmor').exists())

    def test_userns_restriction_reads_the_apparmor_switch(self):
        with tempfile.TemporaryDirectory() as name:
            switch = Path(name) / 'apparmor_restrict_unprivileged_userns'
            with patch.object(install, 'USERNS_RESTRICTION', switch):
                self.assertFalse(install.userns_restricted())   # 22.04's kernels have no switch
                switch.write_text('0\n'); self.assertFalse(install.userns_restricted())
                switch.write_text('1\n'); self.assertTrue(install.userns_restricted())

    def test_hive_memory_cap_is_the_machines_memory(self):
        with tempfile.TemporaryDirectory() as name:
            meminfo = Path(name) / 'meminfo'
            meminfo.write_text('MemTotal:       16314036 kB\nMemFree:         2097152 kB\n')
            self.assertEqual(install.hive_memory_max(meminfo), 16314036 * 1024)
            meminfo.write_text('MemFree:         2097152 kB\n')
            with self.assertRaises(install.Refused):
                install.hive_memory_max(meminfo)
        self.assertEqual(install.HIVE_TASKS_MAX, 8768)

    def test_preflight_accepts_ubuntu_22_04_24_04_and_26_04_only(self):
        for text, ok in (('ID=ubuntu\nVERSION_ID="22.04"\n', True), ('ID=ubuntu\nVERSION_ID="24.04"\n', True),
                         ('ID=ubuntu\nVERSION_ID="26.04"\n', True), ('ID=ubuntu\nVERSION_ID="20.04"\n', False),
                         ('ID=ubuntu\nVERSION_ID="25.10"\n', False),
                         ('ID=debian\nVERSION_ID="12"\n', False), ('VERSION_ID="22.04"\n', False)):
            with self.subTest(release=text), patch.object(install.P, 'read_text', return_value=text), \
                 patch.object(install.platform, 'machine', return_value='x86_64'), \
                 patch.object(install.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)), \
                 patch.object(install.ctypes, 'CDLL') as native:
                native.return_value.syscall.return_value = 4
                if ok:
                    self.assertEqual(install.preflight(Path('/unused'), 5 * 1024**3), 'x86_64')
                else:
                    with self.assertRaisesRegex(install.Refused, 'supports Ubuntu 22.04, 24.04 and 26.04'):
                        install.preflight(Path('/unused'), 5 * 1024**3)

    def test_catalogue_needs_a_pinned_omega_core_bundle(self):
        install.validate_catalogue(catalogue())
        for change in (lambda c: c.pop('omega_core'), lambda c: c['omega_core'].update(path='omega-core.bundle'),
                       lambda c: c['omega_core'].update(path='payload/omega-core-abcdef1.bundle'),
                       lambda c: c['omega_core'].update(sha256=None), lambda c: c['omega_core'].update(bytes=0),
                       lambda c: c['omega_core'].update(revision='a' * 40)):
            value = catalogue(); change(value)
            with self.subTest(core=value.get('omega_core')), self.assertRaises(install.Refused):
                install.validate_catalogue(value)

    def test_omega_core_is_set_up_from_the_bundle_of_the_pinned_revision(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve(); bundle = root / 'bundle'; app = root / 'app'; bundle.mkdir(); app.mkdir()
            raw = b'synthetic git bundle, never fetched'
            for revision, ok in (('abcdef1' + '0' * 33, True), ('1234567' + '0' * 33, False)):
                with self.subTest(revision=revision):
                    (app / 'core-dependency.json').write_text(json.dumps({'revision': revision}))
                    path = bundle / 'omega-core-abcdef1.bundle'; path.unlink(missing_ok=True); path.write_bytes(raw)
                    spec = {'path': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                    instance = install.Installer(bundle, {'omega_core': spec}, root / 'home')
                    calls = []; instance.run = lambda argv, **kwargs: calls.append(argv)
                    if ok:
                        instance.omega_core(app, root / 'venv/bin/python')
                        self.assertEqual(calls, [[str(root / 'venv/bin/python'), '-I', '-B', str(app / 'scripts/setup_core.py'),
                                                  '--source', str(path)]])
                    else:
                        with self.assertRaisesRegex(install.Refused, 'not the revision this release pins'):
                            instance.omega_core(app, root / 'venv/bin/python')
                        self.assertEqual(calls, [])

    def test_linger_user_comes_from_the_uid_and_refuses_odd_names(self):
        for name, ok in (('ann', True), ('l0r7demo', True), ('_svc-1', True), ('Ann', False), ('a b', False), ('-x', False), ('', False)):
            with self.subTest(name=name), patch.object(install.pwd, 'getpwuid', return_value=SimpleNamespace(pw_name=name)):
                if ok:
                    self.assertEqual(install.linger_user(), name)
                else:
                    with self.assertRaises(install.Refused): install.linger_user()

    def test_uninstall_linger_note_names_the_disable_command(self):
        self.assertTrue(install.LINGER_NOTE.endswith('sudo loginctl disable-linger '))

    def test_environment_drops_ambient_keys_and_model_settings(self):
        with patch.dict(install.os.environ, {'OPENROUTER_API_KEY': 'not-exported', 'HIVE_DEFAULT_MODEL': 'mock/free', 'LD_LIBRARY_PATH': '/unsafe'}):
            env = install.clean_env(Path('/safe-home'), '/usr/bin:/bin')
        self.assertNotIn('OPENROUTER_API_KEY', env)
        self.assertNotIn('HIVE_DEFAULT_MODEL', env)
        self.assertNotIn('LD_LIBRARY_PATH', env)

    def test_gui_context_reaches_only_control_open_and_user_bus_is_derived(self):
        with patch.dict(install.os.environ, {'DISPLAY': ':1', 'WAYLAND_DISPLAY': 'wayland-0',
                'XAUTHORITY': '/home/user/.Xauthority', 'OPENROUTER_API_KEY': 'not-exported',
                'DBUS_SESSION_BUS_ADDRESS': 'untrusted'}), \
                patch.object(install, 'plain'), \
                patch.object(install.P, 'stat', return_value=SimpleNamespace(st_mode=0o40700)):
            headless = install.control_env(Path('/home/user'))
            desktop = install.control_env(Path('/home/user'), browser=True)
        self.assertNotIn('DISPLAY', headless)
        self.assertEqual(desktop['DISPLAY'], ':1')
        self.assertNotIn('OPENROUTER_API_KEY', desktop)
        self.assertEqual(desktop['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/' + str(install.os.getuid()) + '/bus')

    def test_curl_has_no_ambient_configuration_proxy_or_protocol_extension(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance = install.Installer(home, {}, home)
            instance.root.mkdir(parents=True); commands = []
            raw = b'reviewed download'; pin = {'url': 'https://github.com/publisher/release', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            def download(argv, **kwargs):
                commands.append((argv, kwargs)); Path(argv[argv.index('--output') + 1]).write_bytes(raw)
            instance.run = download
            self.assertEqual(instance.fetch(pin).read_bytes(), raw)
            argv, kwargs = commands[0]
            self.assertEqual(argv[:2], ['/usr/bin/curl', '--disable'])
            self.assertEqual(argv[argv.index('--proxy') + 1], '')
            self.assertEqual(argv[argv.index('--proto') + 1], '=https')
            self.assertEqual(argv[argv.index('--proto-redir') + 1], '=https')
            # A slow download goes on to its end; one that moves under a byte a second for the stall time stops.
            self.assertNotIn('--max-time', argv); self.assertEqual(kwargs, {'timeout': None})
            self.assertEqual(argv[argv.index('--speed-limit') + 1], '1')
            self.assertEqual(argv[argv.index('--speed-time') + 1], str(install.DOWNLOAD_STALL_SECONDS))

    def test_uninstall_refuses_the_releases_container_before_commands_or_deletion(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); root = home / '.local/share/omegahive'; releases = root / 'releases'
            releases.mkdir(parents=True)
            state = {'schema': 'studio-linux-user-installation/1', 'runtime_root': str(releases),
                     'unit': str(home / '.config/systemd/user/omegahive.service'), 'unit_sha256': '0' * 64,
                     'python': str(releases / 'python'), 'control': str(releases / 'control.py'),
                     'data_dir': str(root / 'data'), 'libpython_dir': None}
            (root / 'installation-state.json').write_text(json.dumps(state))
            with patch.object(install.subprocess, 'run') as command, self.assertRaises(install.Refused):
                install.manage('uninstall', home)
            command.assert_not_called(); self.assertTrue(releases.exists())

    def test_venv_python_keeps_environment_path_and_cfg_with_a_regular_copy(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); base = root / 'base/python3.12'; base.parent.mkdir()
            base.write_bytes(b'reviewed-python-binary'); base.chmod(0o555)
            environment = root / 'venv'; (environment / 'bin').mkdir(parents=True)
            config = environment / 'pyvenv.cfg'; config.write_text('home = ' + str(base.parent) + '\n')
            executable = environment / 'bin/python'; executable.symlink_to(base)
            selected = install.materialize_venv_python(executable, base)
            self.assertEqual(selected, executable)
            self.assertFalse(selected.is_symlink())
            self.assertEqual(selected.resolve(), executable)
            self.assertEqual(selected.read_bytes(), base.read_bytes())
            self.assertEqual(config.read_text(), 'home = ' + str(base.parent) + '\n')

    def test_venv_python_cannot_copy_an_unexpected_interpreter(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); base = root / 'base'; other = root / 'other'
            base.write_bytes(b'expected'); other.write_bytes(b'unexpected')
            (root / 'bin').mkdir(); executable = root / 'bin/python'; executable.symlink_to(other)
            with self.assertRaises(install.Refused): install.materialize_venv_python(executable, base)
            self.assertTrue(executable.is_symlink())

    def test_failure_with_descendants_cleans_while_leader_is_held(self):
        instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
        process = SimpleNamespace(pid=12345, returncode=None)
        events = []
        def reap(timeout):
            events.append(('reap', process.returncode)); process.returncode = 0; return 0
        process.wait = reap
        leader = (12345, install.os.getpid(), 12345, 12345, install.os.getuid(), 'Z')
        descendant = (12346, 1, 12345, 12345, install.os.getuid(), 'S')
        def signal_group(pid, number):
            self.assertIsNone(process.returncode); events.append(('signal', pid, number))
        with patch.object(install.subprocess, 'Popen', return_value=process), \
                patch.object(install.os, 'waitid', return_value=object(), create=True), \
                patch.object(install.signal, 'getsignal', return_value=install.signal.SIG_DFL), \
                patch.object(instance, 'group_rows', side_effect=[[leader, descendant], [leader, descendant], [leader]]), \
                patch.object(install.os, 'killpg', side_effect=signal_group), \
                self.assertRaises(install.Refused):
            instance.run(['/synthetic/step'])
        self.assertEqual(events[0], ('signal', 12345, install.signal.SIGTERM))
        self.assertEqual(events[-1], ('reap', None))

    def test_cleanup_never_signals_a_reaped_identity(self):
        instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
        with patch.object(install.os, 'killpg') as signal_group, patch.object(instance, 'group_rows') as snapshot:
            instance.cleanup_group(SimpleNamespace(pid=12345, returncode=0))
        signal_group.assert_not_called(); snapshot.assert_not_called()

    def test_cleanup_failed_ownership_does_not_signal_or_claim_reap(self):
        instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
        process = SimpleNamespace(pid=12345, returncode=None)
        with patch.object(instance, 'group_rows', side_effect=install.Refused('ownership')), \
                patch.object(install.os, 'killpg') as signal_group, self.assertRaises(install.Refused):
            instance.cleanup_group(process)
        self.assertIsNone(process.returncode); signal_group.assert_not_called()

    def test_privileged_session_admits_apt_download_methods_and_no_other_user(self):
        # apt runs its download methods as its sandbox user inside the package step's session (real uid 100 on 22.04,
        # 42 on 24.04 and 26.04). Cleanup admits that user in a privileged session only, and still no other user.
        instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
        process = SimpleNamespace(pid=4242, returncode=None)
        me, sandbox, stranger = install.os.getuid(), 4100, 4200
        def snapshot(third):
            table = [(4242, install.os.getpid(), 4242, 4242, me, 'Ss'), (4243, 4242, 4242, 4242, 0, 'S'), third]
            text = ''.join('%d %d %d %d %d %s\n' % row for row in table)
            original = subprocess.Popen
            return lambda argv, **kwargs: original([install.sys.executable, '-I', '-c', 'import sys; sys.stdout.write(%r)' % text],
                                                   **kwargs)
        method = (4244, 4243, 4242, 4242, sandbox, 'S')
        with tempfile.TemporaryFile() as log, patch.object(install, 'apt_sandbox_uid', return_value=sandbox):
            instance.log = log
            with patch.object(install.subprocess, 'Popen', side_effect=snapshot(method)):
                rows = instance.group_rows(process, install.time.monotonic() + 10, privileged=True)
            self.assertEqual([row[4] for row in rows], [me, 0, sandbox])
            for privileged, third in ((False, method), (True, (4244, 4243, 4242, 4242, stranger, 'S'))):
                with self.subTest(privileged=privileged, uid=third[4]), \
                        patch.object(install.subprocess, 'Popen', side_effect=snapshot(third)), \
                        self.assertRaises(install.Refused):
                    instance.group_rows(process, install.time.monotonic() + 10, privileged=privileged)

    def test_step_without_a_deadline_runs_to_its_end(self):
        instance = install.Installer(Path('/unused'), {}, Path.home())
        with tempfile.TemporaryFile() as log:
            instance.log = log
            instance.run([install.sys.executable, '-I', '-c', 'import time; time.sleep(0.3)'], timeout=None)

    def test_service_and_shell_quoting_have_separate_contracts(self):
        with tempfile.TemporaryDirectory(prefix='home-shell-') as name:
            home = Path(name); root = home / '.local/share/omegahive'; root.mkdir(parents=True)
            app = root / 'releases/test/app'; module = app / 'deploy/linux'; module.mkdir(parents=True)
            (module / 'omegahive.service.in').write_text('[Service]\nExecStart=@PYTHON@ -I -B @SERVE@ --runtime @RUNTIME@\nWorkingDirectory=@WORKDIR@\nEnvironment=@SANDBOX_ENV@\nEnvironment=@LIBPYTHON_ENV@\n')
            (module / 'omegacode.service.in').write_text(CODE_TEMPLATE)
            instance = install.Installer(Path('/unused'), {}, home); calls = []; runtimes = []
            runtime = home / 'run'; runtime.mkdir(mode=0o700)
            def run(argv, **kwargs):
                calls.append(argv); scratch = Path(kwargs['env']['XDG_RUNTIME_DIR'])
                runtimes.append((scratch, scratch.is_dir())); self.assertEqual(kwargs['env']['TEST'], 'owned-session')
            instance.run = run
            python = root / 'releases/test/venv/bin/python'
            descriptor = {'runtime_root': str(app.parent), 'sandbox_python': str(python), 'data_dir': str(root / 'data'), 'libpython_dir': str(app.parent / 'runtime/python/lib'), 'code_service': code_record(root)}
            with patch.object(install, 'control_env', return_value={'TEST': 'owned-session', 'XDG_RUNTIME_DIR': str(runtime)}):
                instance.activate(app, python, descriptor)
            lines = (home / '.local/bin/omegahive').read_text().splitlines()
            self.assertEqual(lines[1], 'unset LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME')
            shim = lines[2]
            self.assertEqual(shlex.split(shim), ['LD_LIBRARY_PATH=' + descriptor['libpython_dir'], 'exec', str(python), '-I', '-B', str(root / 'bin/install.py'), '$@'])
            self.assertIn('Environment="LD_LIBRARY_PATH=' + descriptor['libpython_dir'] + '"', (home / '.config/systemd/user/omegahive.service').read_text())
            units = home / '.config/systemd/user'
            self.assertEqual(calls, [['/usr/bin/systemd-analyze', '--user', 'verify', str(units / 'omegahive.service'), str(units / 'omegacode.service')],
                                     ['/usr/bin/systemctl', '--user', 'daemon-reload'],
                                     ['/usr/bin/systemctl', '--user', 'enable', 'omegahive.service', 'omegacode.service'],
                                     ['/usr/bin/systemctl', '--user', 'start', 'omegahive.service'],
                                     ['/usr/bin/systemctl', '--user', 'start', 'omegacode.service']])
            code_unit = (units / 'omegacode.service').read_text()
            code = code_record(root)
            self.assertIn('ExecStart=' + str(python) + ' -B -s -m omegacode --config ' + code['config'] + '\n', code_unit)
            self.assertIn('Environment=PYTHONPATH=' + code['root'] + '/releases/' + code['release'] + '\n', code_unit)
            self.assertIn('WorkingDirectory=' + code['root'] + '/wd\n', code_unit)
            self.assertIn('AppArmorProfile=omegahive-code-' + str(install.os.getuid()) + '\n', code_unit)
            self.assertNotRegex(code_unit, '@[A-Za-z_]+@')
            self.assertEqual(json.loads((root / 'installation-state.json').read_text())['schema'], 'studio-linux-user-installation/3')
            # verify ran in a runtime directory of its own, gone now, so it never replaced the manager's private socket.
            (scratch, existed), *managed = runtimes
            self.assertEqual(scratch.parent, runtime); self.assertTrue(scratch.name.startswith('verify-'))
            self.assertTrue(existed); self.assertFalse(scratch.exists())
            self.assertEqual(managed, [(runtime, True)] * 4)

    def test_rendered_service_verification_failure_refuses_before_start_or_shim(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); root = home / '.local/share/omegahive'; root.mkdir(parents=True)
            app = root / 'releases/test-1/app'; module = app / 'deploy/linux'; module.mkdir(parents=True)
            (module / 'omegahive.service.in').write_text('[Service]\nExecStart=@PYTHON@ -I -B @SERVE@ --runtime @RUNTIME@\nWorkingDirectory=@WORKDIR@\nEnvironment=@SANDBOX_ENV@\nEnvironment=@LIBPYTHON_ENV@\n')
            (module / 'omegacode.service.in').write_text(CODE_TEMPLATE)
            instance = install.Installer(Path('/unused'), {}, home); calls = []; scratches = []
            runtime = home / 'run'; runtime.mkdir(mode=0o700)
            def refuse(argv, **kwargs):
                calls.append(argv); scratches.append(Path(kwargs['env']['XDG_RUNTIME_DIR']))
                raise install.Refused('synthetic invalid unit')
            instance.run = refuse
            python = root / 'releases/test-1/venv/bin/python'
            descriptor = {'runtime_root': str(app.parent), 'sandbox_python': str(python),
                          'data_dir': str(root / 'data'), 'libpython_dir': None, 'code_service': code_record(root)}
            with patch.object(install, 'control_env', return_value={'TEST': 'owned-session', 'XDG_RUNTIME_DIR': str(runtime)}):
                with self.assertRaisesRegex(install.Refused, 'user service could not be validated'):
                    instance.activate(app, python, descriptor)
            self.assertEqual(calls, [['/usr/bin/systemd-analyze', '--user', 'verify', str(home / '.config/systemd/user/omegahive.service'),
                                      str(home / '.config/systemd/user/omegacode.service')]])
            self.assertEqual(scratches[0].parent, runtime); self.assertFalse(scratches[0].exists())
            self.assertFalse((home / '.local/bin/omegahive').exists())
            self.assertFalse((root / 'installation-state.json').exists())

    def test_percent_paths_refuse_before_generated_service_commands(self):
        with self.assertRaises(install.Refused):
            install.Installer(Path('/unused'), {}, Path('/home/percent%name'))
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); root = home / '.local/share/omegahive'; root.mkdir(parents=True)
            app = root / 'releases/percent%release/app'; module = app / 'deploy/linux'; module.mkdir(parents=True)
            (module / 'omegahive.service.in').write_text('[Service]\nExecStart=@PYTHON@\n')
            (module / 'omegacode.service.in').write_text(CODE_TEMPLATE)
            instance = install.Installer(Path('/unused'), {}, home); calls = []
            instance.run = lambda argv, **kwargs: calls.append(argv)
            python = app.parent / 'venv/bin/python'
            with self.assertRaises(install.Refused):
                instance.activate(app, python, {'runtime_root': str(app.parent), 'sandbox_python': str(python), 'data_dir': str(root / 'data'), 'libpython_dir': None, 'code_service': code_record(root)})
            self.assertEqual(calls, [])
            self.assertFalse((home / '.config/systemd/user/omegahive.service').exists())

    def test_uninstall_removes_shim_before_a_runtime_delete_failure(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); paths = installed_fixture(home)
            def fail_runtime(path):
                self.assertEqual(path, paths['runtime'])
                self.assertFalse(paths['shim'].exists())
                raise OSError('synthetic delete failure')
            with patch.object(install, 'control_env', return_value={}), patch.object(install.subprocess, 'run'), \
                 patch('builtins.input', return_value=''), patch.object(install.shutil, 'rmtree', side_effect=fail_runtime):
                with self.assertRaises(OSError): install.manage('uninstall', home)
            self.assertFalse(paths['shim'].exists())
            self.assertTrue(paths['runtime'].exists()); self.assertTrue(paths['state'].exists())
            self.assertTrue(paths['data'].exists()); self.assertTrue(paths['unrelated'].exists())

    def test_delete_happy_path_removes_only_recorded_data_and_selected_release(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); paths = installed_fixture(home)
            with patch.object(install, 'control_env', return_value={}), patch.object(install.subprocess, 'run') as commands, \
                 patch('builtins.input', return_value='DELETE'):
                self.assertEqual(install.manage('uninstall', home), 0)
            self.assertFalse(paths['shim'].exists()); self.assertFalse(paths['runtime'].exists())
            self.assertFalse(paths['state'].exists()); self.assertFalse(paths['unit'].exists())
            self.assertFalse(paths['data'].exists()); self.assertFalse((paths['root'] / 'runtime.json').exists())
            for key in ('unrelated', 'other_release', 'cache'):
                self.assertEqual((paths[key] / 'sentinel').read_text(), 'keep')
            self.assertEqual([call.args[0] for call in commands.call_args_list],
                [['/usr/bin/systemctl', '--user', 'stop', 'omegahive.service'], ['/usr/bin/systemctl', '--user', 'disable', 'omegahive.service'], ['/usr/bin/systemctl', '--user', 'daemon-reload']])

    def test_prebuilt_ui_exact_files_materialize_without_processes_or_archive_changes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive, manifest, spec, bodies = prebuilt_fixture(root)
            original = archive.read_bytes(); dest = root / 'dist'
            with patch.object(install.subprocess, 'Popen', side_effect=AssertionError('No UI build process')) as spawn:
                self.assertEqual(install.extract_prebuilt_ui(archive, manifest, dest, spec), manifest.read_bytes())
                spawn.assert_not_called()
            for path, raw in bodies.items(): self.assertEqual((dest / path).read_bytes(), raw)
            self.assertEqual(archive.read_bytes(), original)
            self.assertEqual(spec['source_revision'], '4' * 40)
            self.assertNotEqual(spec['source_revision'], catalogue()['source_revision'])

    def test_prebuilt_ui_missing_changed_and_extra_files_are_refused_after_archive_repin(self):
        cases = [[('dist/index.html', b'<!doctype html>synthetic UI', None)],
            [('dist/index.html', b'changed', None), ('dist/assets/app.js', b'/* synthetic static asset */', None)],
            [('dist/index.html', b'<!doctype html>synthetic UI', None), ('dist/assets/app.js', b'/* synthetic static asset */', None), ('dist/extra.js', b'extra', None)]]
        for entries in cases:
            with self.subTest(entries=[x[0] for x in entries]), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive, manifest, spec, _ = prebuilt_fixture(root, members=entries)
                with self.assertRaises(install.Refused): install.extract_prebuilt_ui(archive, manifest, root / 'dist', spec)

    def test_prebuilt_ui_links_wrong_prefix_duplicates_and_extra_directories_are_refused(self):
        cases = [[('dist/index.html', b'', 'outside')], [('wrong/index.html', b'data', None)],
                 [('dist/extra/', None, None)], [('dist/index.html', b'a', None), ('dist/index.html', b'b', None)]]
        for entries in cases:
            with self.subTest(entries=[x[0] for x in entries]), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive, manifest, spec, _ = prebuilt_fixture(root, members=entries)
                with self.assertRaises(install.Refused): install.extract_prebuilt_ui(archive, manifest, root / 'dist', spec)
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive, manifest, spec, _ = prebuilt_fixture(root)
            with tarfile.open(archive, 'w:gz') as stream:
                info = tarfile.TarInfo('dist/index.html'); info.type = tarfile.LNKTYPE; info.linkname = 'dist/other'; stream.addfile(info)
            spec['archive'].update(bytes=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
            with self.assertRaises(install.Refused): install.extract_prebuilt_ui(archive, manifest, root / 'dist', spec)

    def test_prebuilt_ui_provenance_inventory_and_input_checksums_are_closed(self):
        changes = [lambda d: d.update(source_commit='9' * 40), lambda d: d.update(source_tree='9' * 40),
                   lambda d: d.update(file_count=True), lambda d: d.update(extra='unknown'),
                   lambda d: d['files'].update({'../escape': {'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}})]
        for change in changes:
            with self.subTest(change=changes.index(change)), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive, manifest, spec, _ = prebuilt_fixture(root, manifest_change=change)
                with self.assertRaises(install.Refused): install.extract_prebuilt_ui(archive, manifest, root / 'dist', spec)
                self.assertFalse((root / 'dist').exists())
        for key in ('archive', 'manifest'):
            with self.subTest(pin=key), tempfile.TemporaryDirectory() as name:
                root = Path(name); archive, manifest, spec, _ = prebuilt_fixture(root); spec[key]['sha256'] = '0' * 64
                with self.assertRaises(install.Refused): install.extract_prebuilt_ui(archive, manifest, root / 'dist', spec)
                self.assertFalse((root / 'dist').exists())

    def test_release_v2_prebuilt_ui_has_own_provenance_and_no_node_metadata(self):
        value = catalogue()
        self.assertIs(install.validate_catalogue(value), value)
        self.assertNotEqual(value['ui_prebuilt']['source_revision'], value['source_revision'])
        for mutation in ('legacy_schema', 'node_version', 'unversioned_node', 'missing_ui', 'ui_prefix'):
            value = catalogue()
            if mutation == 'legacy_schema': value['schema'] = 'studio-linux-user-release/1'
            elif mutation == 'node_version': value['node_version'] = '22.1.0'
            elif mutation == 'unversioned_node': value['platforms']['aarch64']['node'] = dict(value['platforms']['aarch64']['uv'])
            elif mutation == 'missing_ui': value.pop('ui_prebuilt')
            else: value['ui_prebuilt']['prefix'] = 'untrusted/'
            with self.subTest(mutation=mutation), self.assertRaises(install.Refused): install.validate_catalogue(value)

    def test_installer_runs_node_only_as_the_pinned_runtime_and_never_npm_or_a_ui_build(self):
        # The UI ships prebuilt, so no npm, npx or corepack runs and nothing is built with Node; the one Node the
        # installer runs is the pinned nodejs.org runtime a Code proposal's project check uses, asked its version.
        tree = ast.parse(Path(install.__file__).read_text())
        cls = next(x for x in tree.body if isinstance(x, ast.ClassDef) and x.name == 'Installer')
        body = next(x for x in cls.body if isinstance(x, ast.FunctionDef) and x.name == 'install')
        names = {x.id for x in ast.walk(body) if isinstance(x, ast.Name)}
        self.assertTrue(names.isdisjoint({'npm', 'npx', 'corepack'}))
        runs = [ast.unparse(x) for x in ast.walk(body) if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr == 'run']
        self.assertEqual([text for text in runs if 'nodelink' in text or 'node' in text.split(',')[0]],
                         [text for text in runs if 'process.version' in text])
        self.assertEqual(len([text for text in runs if 'process.version' in text]), 1)
        for text in runs:
            self.assertNotIn('bin/npm', text); self.assertNotIn('npx', text); self.assertNotIn("['npm']", text)
        self.assertTrue(set(install.APT).isdisjoint({'nodejs', 'npm'}))
        self.assertNotIn('node_version', catalogue())


    def test_open_after_stop_starts_user_service_before_control_handoff(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); paths = installed_fixture(home)
            with patch.object(install, 'control_env', return_value={}), \
                 patch.object(install.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
                self.assertEqual(install.manage('stop', home), 0)
                self.assertEqual(install.manage('open', home), 0)
            calls = run.call_args_list
            self.assertEqual(calls[0].args[0], ['/usr/bin/systemctl', '--user', 'stop', 'omegahive.service'])
            self.assertEqual(calls[1].args[0], ['/usr/bin/systemctl', '--user', 'start', 'omegahive.service'])
            self.assertEqual(calls[1].kwargs['timeout'], 90)
            self.assertEqual(calls[2].args[0][-1], 'open')
            self.assertEqual(calls[2].kwargs['timeout'], install.OPEN_TIMEOUT)
            self.assertTrue(paths['data'].exists())

    def test_status_json_is_explicit_and_does_not_start_the_service(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); installed_fixture(home)
            with patch.object(install, 'control_env', return_value={}), \
                 patch.object(install.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
                self.assertEqual(install.manage('status', home), 0)
                self.assertEqual(install.manage('status', home, json_output=True), 0)
            self.assertEqual(len(run.call_args_list), 2)
            self.assertEqual(run.call_args_list[0].args[0][-1], 'status')
            self.assertEqual(run.call_args_list[1].args[0][-2:], ['status', '--json'])
            self.assertTrue(all(call.kwargs['timeout'] == 15 for call in run.call_args_list))
            with self.assertRaises(install.Refused): install.manage('open', home, json_output=True)

    def test_partial_uninstall_works_before_private_python_and_preserves_user_files(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            (runtime / 'extracted-source').write_text('partial release')
            for folder in ('data', 'cache'):
                (instance.root / folder).mkdir(); (instance.root / folder / 'keep').write_text(folder)
            (instance.root / 'logs/failed.log').write_text('retained failure')
            other = instance.root / 'releases/other-2'; other.mkdir(); (other / 'keep').write_text('other')
            shim = home / '.local/bin/omegahive'
            self.assertIn('/usr/bin/python3 -I -B', shim.read_text())
            with patch.object(install.subprocess, 'run') as run:
                self.assertEqual(install.manage('uninstall', home), 0)
                run.assert_not_called()
            self.assertFalse(runtime.exists()); self.assertFalse(shim.exists())
            self.assertFalse((instance.root / 'bin/install.py').exists())
            self.assertFalse((instance.root / 'install-progress.json').exists())
            self.assertEqual((instance.root / 'data/keep').read_text(), 'data')
            self.assertEqual((instance.root / 'cache/keep').read_text(), 'cache')
            self.assertEqual((instance.root / 'logs/failed.log').read_text(), 'retained failure')
            self.assertEqual((other / 'keep').read_text(), 'other')
            self.assertTrue(list((instance.root / 'logs').glob('incomplete-*.json')))

    def test_partial_cleanup_refuses_unknown_targets_replacement_and_symlink(self):
        for change in ('unknown_kind', 'wrong_inode', 'symlink'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as name:
                home = Path(name); instance, runtime = partial_fixture(home)
                outside = home / 'outside'; outside.mkdir(); (outside / 'keep').write_text('outside')
                marker = instance.root / 'install-progress.json'; value = json.loads(marker.read_text())
                if change == 'unknown_kind': value['owned_files']['../outside'] = [{'bytes': 0, 'sha256': '0' * 64}]
                elif change == 'wrong_inode': value['runtime_identity']['inode'] += 1
                else:
                    runtime.rmdir(); runtime.symlink_to(outside, target_is_directory=True)
                marker.write_text(json.dumps(value))
                with patch.object(install.subprocess, 'run') as run, self.assertRaises(install.Refused):
                    install.recover_partial(home)
                run.assert_not_called(); self.assertEqual((outside / 'keep').read_text(), 'outside')
                self.assertTrue(marker.exists()); self.assertTrue((home / '.local/bin/omegahive').exists())

    def test_partial_cleanup_rejects_changed_owned_file_before_service_or_deletion(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            shim = home / '.local/bin/omegahive'; shim.write_text('changed outside this setup')
            with patch.object(install.subprocess, 'run') as run, self.assertRaises(install.Refused):
                install.recover_partial(home)
            run.assert_not_called(); self.assertTrue(runtime.exists()); self.assertTrue(shim.exists())

    def test_partial_cleanup_refuses_foreign_runtime_descriptor_without_using_its_paths(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            outside = home / 'outside'; outside.mkdir(); (outside / 'keep').write_text('outside')
            (instance.root / 'runtime.json').write_text(json.dumps({'runtime_root': str(outside), 'data_dir': str(outside)}))
            with patch.object(install.subprocess, 'run') as run, self.assertRaises(install.Refused):
                install.recover_partial(home)
            run.assert_not_called(); self.assertEqual((outside / 'keep').read_text(), 'outside')
            self.assertTrue(runtime.exists()); self.assertTrue((instance.root / 'runtime.json').exists())

    def test_partial_cleanup_stops_and_disables_only_its_pinned_service(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            unit = home / '.config/systemd/user/omegahive.service'; unit.parent.mkdir(parents=True)
            install.owned_file(home, 'unit', b'[Service]\nExecStart=/synthetic-never-run\n')
            commands = []
            def command(argv, **kwargs):
                commands.append(argv)
                if argv[-1] == 'omegahive.service': self.assertTrue(unit.exists())
                return SimpleNamespace(returncode=0)
            with patch.object(install, 'control_env', return_value={}), patch.object(install.subprocess, 'run', side_effect=command):
                install.recover_partial(home)
            self.assertEqual(commands, [['/usr/bin/systemctl', '--user', 'stop', 'omegahive.service'],
                ['/usr/bin/systemctl', '--user', 'disable', 'omegahive.service'],
                ['/usr/bin/systemctl', '--user', 'daemon-reload']])
            self.assertFalse(unit.exists()); self.assertFalse(runtime.exists())

    def test_unrecorded_legacy_partial_is_not_guessed_or_removed(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); root = home / '.local/share/omegahive'; runtime = root / 'releases/legacy-1'
            runtime.mkdir(parents=True); (runtime / 'keep').write_text('unrecorded')
            (root / 'runtime.json').write_text(json.dumps({'runtime_root': str(runtime)}))
            with patch.object(install.subprocess, 'run') as run, self.assertRaisesRegex(install.Refused, 'no complete installation record'):
                install.manage('uninstall', home)
            run.assert_not_called(); self.assertEqual((runtime / 'keep').read_text(), 'unrecorded')

    def complete_workflow(self, restricted):
        """Fail once after extraction, rerun to completion, and return every command with the hive's private root."""
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); root = home / '.local/share/omegahive'; root.mkdir(parents=True, mode=0o700)
            for folder in ('data', 'cache'):
                (root / folder).mkdir(mode=0o700); (root / folder / 'keep').write_text(folder)
            bundle = home / 'bundle'; bundle.mkdir(); payload = bundle / 'synthetic'; payload.write_bytes(b'not executed')
            value = catalogue(); attempted = []; commands = []
            def source(_archive, destination, rows, _prefix):
                destination.mkdir(); attempted.append(destination)
                for item in rows:
                    path = destination / item['path']; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'')
                if len(attempted) == 1:
                    (destination / 'old-partial').write_text('retained until recovery')
                    raise install.Refused('synthetic extraction failure')
                self.assertFalse((destination / 'old-partial').exists())
            def tool(_archive, destination):
                destination.mkdir(parents=True)
                if destination.name == 'uv': (destination / 'uv').write_bytes(b'never executed')
                if destination.name == 'node':
                    (destination / 'bin').mkdir(); (destination / 'bin/node').write_bytes(b'never executed')
                if destination.name == 'python':
                    (destination / 'bin').mkdir(); (destination / 'lib').mkdir()
                    (destination / 'bin/python3.12').write_bytes(b'never executed')
            def venv(path, _source):
                path.parent.mkdir(parents=True); path.write_bytes(b'never executed'); return path
            def run(instance, argv, **kwargs):
                commands.append(argv)
                if argv[0] == '/usr/bin/systemd-analyze':
                    scratch = Path(kwargs['env']['XDG_RUNTIME_DIR'])
                    self.assertEqual(scratch.parent, runtime); self.assertTrue(scratch.is_dir())
                if argv[:2] == ['/usr/bin/cmake', '--install']:
                    prefix = root / 'releases/test-1/runtime/swipl'
                    target = prefix / 'lib/swipl/bin/aarch64-linux/swipl'
                    target.parent.mkdir(parents=True); target.write_bytes(b'never executed'); target.chmod(0o700)
                    launcher = prefix / 'bin/swipl'; launcher.parent.mkdir()
                    launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
            def ui(_archive, _manifest, destination, _provenance):
                destination.mkdir(parents=True); return b'{}'
            runtime = home / 'run'; runtime.mkdir(mode=0o700)
            with ExitStack() as stack:
                stack.enter_context(patch.object(install, 'preflight', return_value='aarch64'))
                stack.enter_context(patch.object(install, 'userns_restricted', return_value=restricted))
                stack.enter_context(patch.object(install.Installer, 'omega_core', lambda obj, app, python: commands.append(['omega-core', str(app)])))
                stack.enter_context(patch.object(install, 'apparmor_enabled', return_value=True))
                stack.enter_context(patch.object(install.Installer, 'code_service', lambda obj, app, python: (
                    commands.append(['code-service', str(app)]), code_record(root))[1]))
                stack.enter_context(patch.object(install, 'validate_lock'))
                stack.enter_context(patch.object(install.Installer, 'local', return_value=payload))
                stack.enter_context(patch.object(install.Installer, 'fetch', return_value=payload))
                stack.enter_context(patch.object(install.Installer, 'run', run))
                stack.enter_context(patch.object(install.Installer, "sudo", lambda obj, argv, package_environment=False, **kw: run(obj, ["/usr/bin/sudo", "-S", *argv], **kw)))
                stack.enter_context(patch.object(install, 'extract_source', side_effect=source))
                stack.enter_context(patch.object(install, 'extract_tool', side_effect=tool))
                stack.enter_context(patch.object(install, 'extract_prebuilt_ui', side_effect=ui))
                stack.enter_context(patch.object(install, 'extract_app', side_effect=lambda _a, d, _s: d.mkdir()))
                stack.enter_context(patch.object(install, 'program_digest', return_value='sha256:' + 'd' * 64))
                stack.enter_context(patch.object(install, 'materialize_venv_python', side_effect=venv))
                stack.enter_context(patch.object(install, 'control_env', return_value={'XDG_RUNTIME_DIR': str(runtime)}))
                with self.assertRaisesRegex(install.Refused, 'synthetic extraction failure'):
                    install.Installer(bundle, value, home).install()
                self.assertTrue((root / 'install-progress.json').exists())
                self.assertFalse((root / 'installation-state.json').exists())
                install.Installer(bundle, value, home).install()
            self.assertEqual(len(attempted), 2)
            self.assertFalse((root / 'install-progress.json').exists())
            self.assertTrue((root / 'installation-state.json').exists())
            self.assertTrue(list((root / 'logs').glob('incomplete-*.json')))
            self.assertTrue(list((root / 'logs').glob('completed-*.json')))
            self.assertEqual((root / 'data/keep').read_text(), 'data')
            self.assertEqual((root / 'cache/keep').read_text(), 'cache')
            self.assertIn(['/usr/bin/systemctl', '--user', 'enable', 'omegahive.service', 'omegacode.service'], commands)
            self.assertLess(commands.index(['/usr/bin/systemctl', '--user', 'start', 'omegahive.service']),
                            commands.index(['/usr/bin/systemctl', '--user', 'start', 'omegacode.service']))
            # The executable now sits at the prefix's bin and its installed place links to it (place_swipl).
            canonical_swipl = root / 'releases/test-1/runtime/swipl/bin/swipl'
            self.assertTrue(canonical_swipl.is_file() and not canonical_swipl.is_symlink())
            self.assertEqual((root / 'releases/test-1/runtime/swipl/lib/swipl/bin/aarch64-linux/swipl').resolve(), canonical_swipl)
            self.assertEqual(json.loads((root / 'runtime.json').read_text())['swipl_bin'], str(canonical_swipl))
            descriptor = json.loads((root / 'runtime.json').read_text())
            self.assertEqual(descriptor['schema'], 'studio-linux-user-runtime/3')
            self.assertEqual(descriptor['code_service'], code_record(root))
            self.assertEqual((descriptor['port'], descriptor['browser_port']), (8700, 8701))
            self.assertEqual(len(descriptor), 19)
            self.assertEqual([argv[0] for argv in commands if len(argv) > 1 and argv[1] == '-g'], [str(canonical_swipl)])
            core = commands.index(['omega-core', str(root / 'releases/test-1/app')])
            self.assertLess(core, commands.index(['/usr/bin/systemctl', '--user', 'enable', 'omegahive.service', 'omegacode.service']))
            self.assertGreater(core, max(i for i, argv in enumerate(commands) if len(argv) > 1 and argv[1] == '-g'))
            return commands, root, (root / 'releases/test-1/omegahive.apparmor').exists()

    def test_failure_after_extraction_can_rerun_complete_workflow_without_losing_data(self):
        commands, _root, profile_written = self.complete_workflow(restricted=False)
        self.assertIn(['/usr/bin/unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '/usr/bin/true'], commands)
        # The Code service's profile is loaded on every release; only a restricted host also needs the launcher's.
        self.assertTrue(profile_written)
        self.assertTrue(any(install.APPARMOR_PARSER in argv for argv in commands))

    def test_restricted_userns_host_loads_the_launcher_profile_instead_of_the_plain_probe(self):
        commands, root, profile_written = self.complete_workflow(restricted=True)
        self.assertFalse(any(argv[:1] == ['/usr/bin/unshare'] for argv in commands))
        self.assertTrue(profile_written)
        target = '/etc/apparmor.d/' + install.apparmor_file_name(install.os.getuid())
        source = root / 'releases/test-1/omegahive.apparmor'
        self.assertIn(['/usr/bin/sudo', '-S', '/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', str(source), target], commands)
        self.assertIn(['/usr/bin/sudo', '-S', install.APPARMOR_PARSER, '-r', target], commands)

    def test_disk_refusal_names_required_gb_before_native_sandbox_check(self):
        with patch.object(install.P, 'read_text', return_value='ID=ubuntu\nVERSION_ID="22.04"\n'), \
             patch.object(install.platform, 'machine', return_value='aarch64'), \
             patch.object(install.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)), \
             patch.object(install.ctypes, 'CDLL') as native:
            with self.assertRaisesRegex(install.Refused, 'about 5 GB'):
                install.preflight(Path('/unused'), 5 * 1024**3)
            native.assert_not_called()

    def test_complete_r8_uninstall_retires_only_pinned_manager_and_allows_reinstall(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); paths = installed_fixture(home)
            manager = paths['root'] / 'bin/install.py'; manager.parent.mkdir(); manager.write_bytes(b'owned manager')
            state = json.loads(paths['state'].read_text())
            state.update(schema='studio-linux-user-installation/2', manager_pin={
                'bytes': len(b'owned manager'), 'sha256': hashlib.sha256(b'owned manager').hexdigest()})
            paths['state'].write_text(json.dumps(state))
            with patch.object(install, 'control_env', return_value={}), patch.object(install.subprocess, 'run'), \
                 patch('builtins.input', return_value=''):
                self.assertEqual(install.manage('uninstall', home), 0)
            self.assertFalse(manager.exists()); self.assertTrue(paths['data'].exists())
            instance = install.Installer(home, catalogue(), home)
            instance.begin_progress(paths['root'] / 'releases/test-1')
            self.assertTrue(manager.exists()); self.assertTrue((home / '.local/bin/omegahive').exists())
            self.assertEqual((paths['cache'] / 'sentinel').read_text(), 'keep')
            self.assertEqual((paths['other_release'] / 'sentinel').read_text(), 'keep')

    def test_password_explanation_safe_failure_copy_and_full_path_return_advice(self):
        instance = install.Installer(Path('/unused'), {}, Path('/unused-home'))
        instance.sudo = lambda *_args, **_kwargs: None
        for restricted, steps in ((False, 'five'), (True, 'five')):
            with tempfile.TemporaryDirectory() as name, self.subTest(restricted=restricted):
                output = io.StringIO()
                with patch.object(install, 'userns_restricted', return_value=restricted), \
                        patch.object(install, 'apparmor_enabled', return_value=True), redirect_stdout(output):
                    instance.apt(Path(name).resolve())
                self.assertIn('each of the ' + steps + ' system setup steps', output.getvalue())
                self.assertIn("keep Create's Code service in its own sandbox", output.getvalue())
                self.assertEqual('let its minds start in theirs' in output.getvalue(), restricted)
        source = Path(install.__file__).read_text()
        self.assertIn('Next time, open it with:  ~/.local/bin/omegahive open', source)
        self.assertIn('open a new terminal after signing out and in', source)
        self.assertNotIn('Nothing was sent anywhere', source)
        self.assertIn("couldn't finish setting up. The details are in:", source)


    def test_partial_cleanup_refuses_runtime_swapped_during_stop_and_preserves_both_directories(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            (runtime / 'original').write_text('recorded release')
            retired = runtime.with_name('recorded-kept-2')
            unit = home / '.config/systemd/user/omegahive.service'; unit.parent.mkdir(parents=True)
            install.owned_file(home, 'unit', b'[Service]\nExecStart=/synthetic-never-run\n')
            calls = []
            def command(argv, **kwargs):
                calls.append(argv)
                if argv == ['/usr/bin/systemctl', '--user', 'stop', 'omegahive.service']:
                    runtime.rename(retired)
                    runtime.mkdir(mode=0o700)
                    (runtime / 'foreign').write_text('replacement must survive')
                return SimpleNamespace(returncode=0)
            with patch.object(install, 'control_env', return_value={}), \
                 patch.object(install.subprocess, 'run', side_effect=command), \
                 self.assertRaisesRegex(install.Refused, 'release was replaced'):
                install.recover_partial(home)
            self.assertEqual((runtime / 'foreign').read_text(), 'replacement must survive')
            self.assertEqual((retired / 'original').read_text(), 'recorded release')
            self.assertTrue((instance.root / 'install-progress.json').exists())
            self.assertTrue((home / '.local/bin/omegahive').exists())
            self.assertTrue((instance.root / 'bin/install.py').exists()); self.assertTrue(unit.exists())
            self.assertEqual(calls, [['/usr/bin/systemctl', '--user', 'stop', 'omegahive.service'],
                ['/usr/bin/systemctl', '--user', 'disable', 'omegahive.service']])


class RuntimeDirectoryRepeatTests(unittest.TestCase):
    """Synthetic vendor-header cases; no real vendor download or installation."""
    def setUp(self):
        previous = install.os.umask(0o077)
        self.addCleanup(install.os.umask, previous)
        self.scratch = tempfile.TemporaryDirectory(prefix='runtime-dir-repeat-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)

    def archive(self, entries):
        path = self.root / 'synthetic.tar'
        with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as stream:
            for row in entries:
                member = tarfile.TarInfo(row['name'])
                member.type = row.get('type', tarfile.REGTYPE)
                member.mode = row.get('mode', 0o775 if member.isdir() else 0o644)
                member.uid = member.gid = 0
                member.mtime = row.get('mtime', 100)
                member.pax_headers = row.get('pax_headers', {})
                member.linkname = row.get('linkname', '')
                payload = row.get('payload', b'')
                member.size = row.get('size', len(payload) if member.isfile() else 0)
                stream.addfile(member, io.BytesIO(payload) if member.size else None)
        return path

    @staticmethod
    def directory(**metadata):
        return dict(name='vendor/bench', type=tarfile.DIRTYPE, size=0, **metadata)

    @staticmethod
    def regular(name='vendor/bench', payload=b'synthetic payload\n'):
        return {'name': name, 'type': tarfile.REGTYPE, 'payload': payload}

    @staticmethod
    def link():
        return {'name': 'vendor/bench', 'type': tarfile.SYMTYPE, 'linkname': 'target', 'size': 0}

    def assert_duplicate_refused(self, entries):
        source = self.archive(entries)
        with self.assertRaisesRegex(install.Refused, r'^A runtime archive repeats a filename\.$'):
            install.extract_tool(source, self.root / 'out')

    def test_repeated_zero_directory_twice_ignores_archive_metadata_and_is_private(self):
        source = self.archive([self.directory(mtime=100, pax_headers={'comment': 'first'}, mode=0o775),
                               self.directory(mtime=200, pax_headers={'comment': 'second'}, mode=0o755),
                               self.directory(mtime=300, pax_headers={'comment': 'third'}, mode=0o777)])
        output = self.root / 'out'
        install.extract_tool(source, output)
        self.assertEqual(sorted(path.name for path in output.iterdir()), ['bench'])
        for path in (output, output / 'bench'):
            info = path.lstat()
            self.assertTrue(install.stat.S_ISDIR(info.st_mode))
            self.assertFalse(path.is_symlink())
            self.assertEqual(info.st_uid, install.os.getuid())
            self.assertEqual(install.stat.S_IMODE(info.st_mode), 0o700)

    def test_directory_repeat_after_child_files_keeps_their_payload_and_modes(self):
        payload = b'unchanged child payload\n'
        source = self.archive([self.directory(mtime=100, pax_headers={'comment': 'first'}),
                               self.regular('vendor/bench/input.pl', payload),
                               self.directory(mtime=200, pax_headers={'comment': 'different'})])
        install.pin_file(source, {'bytes': source.stat().st_size,
                                  'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
        output = self.root / 'out'
        install.extract_tool(source, output)
        result = output / 'bench/input.pl'
        self.assertEqual(result.read_bytes(), payload)
        self.assertEqual(install.stat.S_IMODE(result.lstat().st_mode), 0o444)
        self.assertEqual(install.stat.S_IMODE((output / 'bench').lstat().st_mode), 0o700)

    def test_repeated_regular_file_is_refused(self):
        self.assert_duplicate_refused([self.regular(), self.regular(payload=b'different')])

    def test_directory_then_file_at_same_path_is_refused(self):
        self.assert_duplicate_refused([self.directory(), self.regular()])

    def test_file_then_directory_at_same_path_is_refused(self):
        self.assert_duplicate_refused([self.regular(), self.directory()])

    def test_directory_then_symbolic_link_at_same_path_is_refused(self):
        self.assert_duplicate_refused([self.directory(), self.link()])

    def test_symbolic_link_then_directory_at_same_path_is_refused(self):
        self.assert_duplicate_refused([self.link(), self.directory()])

    def test_repeated_symbolic_link_is_refused(self):
        self.assert_duplicate_refused([self.link(), self.link()])

    def test_first_nonzero_sized_relative_directory_is_refused(self):
        entry = self.directory(); entry['size'] = 1; entry['payload'] = b'x'
        source = self.archive([entry])
        with self.assertRaisesRegex(install.Refused, r'^A runtime archive contains an unsupported file\.$'):
            install.extract_tool(source, self.root / 'out')

    def test_repeated_nonzero_sized_directory_is_refused(self):
        entry = self.directory(); entry['size'] = 1; entry['payload'] = b'x'
        self.assert_duplicate_refused([self.directory(), entry])


class SwiplLauncherTests(unittest.TestCase):
    """Synthetic installed SWI layouts; target payloads are never executed."""
    def setUp(self):
        previous = install.os.umask(0o077)
        self.addCleanup(install.os.umask, previous)
        self.scratch = tempfile.TemporaryDirectory(prefix='swipl-launcher-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.prefix = self.root / 'runtime/swipl'
        self.prefix.mkdir(parents=True, mode=0o700)
        self.launcher = self.prefix / 'bin/swipl'
        self.launcher.parent.mkdir(mode=0o700)

    def internal_target(self, mode=0o700):
        target = self.prefix / 'lib/swipl/bin/aarch64-linux/swipl'
        target.parent.mkdir(parents=True, mode=0o700)
        target.write_bytes(b'synthetic SWI payload, never execute\n')
        target.chmod(mode)
        return target

    def test_vendor_relative_launcher_returns_canonical_file_and_plain_stays_strict(self):
        target = self.internal_target()
        self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        with self.assertRaises(install.Refused):
            install.plain(self.launcher)
        self.assertEqual(install.swipl_executable(self.prefix), target)
        self.assertFalse(target.is_symlink())
        self.assertEqual(target.read_bytes(), b'synthetic SWI payload, never execute\n')
        self.assertTrue(self.launcher.is_symlink())

    def test_plain_regular_executable_launcher_remains_supported(self):
        self.launcher.write_bytes(b'never execute'); self.launcher.chmod(0o755)
        self.assertEqual(install.swipl_executable(self.prefix), self.launcher)

    def test_link_into_another_release_folder_is_refused(self):
        outside = self.root / 'runtime/foreign-swipl'
        outside.write_bytes(b'outside the specific SWI prefix'); outside.chmod(0o700)
        self.launcher.symlink_to('../../foreign-swipl')
        with self.assertRaisesRegex(install.Refused, r'^The SWI-Prolog launcher escaped its private prefix\.$'):
            install.swipl_executable(self.prefix)
        self.assertEqual(outside.read_bytes(), b'outside the specific SWI prefix')

    def test_dangling_internal_launcher_is_refused(self):
        self.launcher.symlink_to('../lib/missing')
        with self.assertRaisesRegex(install.Refused, r'^SWI-Prolog did not install a usable launcher\.$'):
            install.swipl_executable(self.prefix)

    def test_looping_launcher_is_refused(self):
        self.launcher.symlink_to('swipl')
        with self.assertRaisesRegex(install.Refused, r'^SWI-Prolog did not install a usable launcher\.$'):
            install.swipl_executable(self.prefix)

    def test_directory_target_is_refused(self):
        target = self.prefix / 'lib'; target.mkdir(mode=0o700)
        self.launcher.symlink_to('../lib')
        with self.assertRaisesRegex(install.Refused, r'^An installation path is not a plain file or folder\.$'):
            install.swipl_executable(self.prefix)

    def test_non_executable_target_is_refused(self):
        self.internal_target(0o600); self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        with self.assertRaisesRegex(install.Refused, r'^The SWI-Prolog launcher is not executable by its owner\.$'):
            install.swipl_executable(self.prefix)

    def test_other_execute_bits_do_not_replace_owner_execute_permission(self):
        self.internal_target(0o611); self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        with self.assertRaisesRegex(install.Refused, r'^The SWI-Prolog launcher is not executable by its owner\.$'):
            install.swipl_executable(self.prefix)

    def test_group_or_world_writable_targets_still_refuse(self):
        target = self.internal_target(); self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        for mode in (0o720, 0o702):
            with self.subTest(mode=mode):
                target.chmod(mode)
                with self.assertRaisesRegex(install.Refused, r'^An installation path has unsafe ownership or permissions:'):
                    install.swipl_executable(self.prefix)

    def test_foreign_owned_target_still_refuses(self):
        target = self.internal_target(); self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        original = Path.lstat
        def foreign(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == target:
                values = list(info); values[4] = info.st_uid + 1
                return install.os.stat_result(values)
            return info
        with patch.object(Path, 'lstat', foreign):
            with self.assertRaisesRegex(install.Refused, r'^An installation path has unsafe ownership or permissions:'):
                install.swipl_executable(self.prefix)

    def test_symlink_prefix_is_not_an_allowed_generic_link(self):
        alias = self.root / 'alias'; alias.symlink_to(self.prefix, target_is_directory=True)
        with self.assertRaisesRegex(install.Refused, r'^An installation path is not a plain file or folder\.$'):
            install.swipl_executable(alias)

    def test_place_puts_the_executable_at_the_prefix_bin_and_links_its_installed_place(self):
        target = self.internal_target(); self.launcher.symlink_to('../lib/swipl/bin/aarch64-linux/swipl')
        self.assertEqual(install.place_swipl(self.prefix), self.launcher)
        self.assertTrue(self.launcher.is_file() and not self.launcher.is_symlink())
        self.assertEqual(self.launcher.read_bytes(), b'synthetic SWI payload, never execute\n')
        self.assertTrue(target.is_symlink())
        self.assertEqual(target.resolve(), self.launcher)
        # the sandbox grants the folder two above the swipl the hive finds: the whole prefix, SWI's home included
        self.assertEqual(self.launcher.resolve().parent.parent, self.prefix)
        self.assertEqual(install.place_swipl(self.prefix), self.launcher)   # a second call changes nothing

    def test_place_keeps_a_launcher_that_is_already_the_executable(self):
        self.launcher.write_bytes(b'never execute'); self.launcher.chmod(0o755)
        self.assertEqual(install.place_swipl(self.prefix), self.launcher)
        self.assertEqual(self.launcher.read_bytes(), b'never execute')


class HeadlessFinalOpenTests(unittest.TestCase):
    def context(self):
        home = Path('/synthetic-home')
        instance = install.Installer(home, catalogue(), home)
        return instance, home / 'release/app', home / 'release/venv/bin/python', home / 'release/runtime/python/lib'

    def test_captured_headless_auto_open_defers_without_minting_or_private_log_output(self):
        instance, app, python, lib = self.context()
        instance.log = io.BytesIO()
        with patch.object(install, 'control_env', return_value={}) as env, \
                patch.object(install, 'stdout_is_terminal', return_value=False), \
                patch.object(instance, 'run') as run:
            instance.open_after_install(app, python, lib)
        argv = run.call_args.args[0]
        self.assertEqual(argv, [str(python), '-I', '-B', str(app / 'deploy/linux/control.py'),
            '--runtime', str(instance.root / 'runtime.json'), 'open', '--defer-headless-signin'])
        self.assertEqual(run.call_args.kwargs, {'timeout': install.OPEN_TIMEOUT, 'console': True, 'env': {}})
        env.assert_called_once_with(instance.home, str(lib), browser=True)
        self.assertEqual(instance.log.getvalue(), b'')
        self.assertNotIn('/local-signin#', ' '.join(argv))

    def test_headless_auto_open_defers_even_with_terminal_stdout(self):
        instance, app, python, lib = self.context()
        out = SimpleNamespace(fileno=lambda: 71)
        stdin = SimpleNamespace(isatty=lambda: False)
        with patch.object(install, 'control_env', return_value={}), \
                patch.object(install.sys, 'stdout', out), patch.object(install.sys, 'stdin', stdin), \
                patch.object(install.os, 'isatty', side_effect=lambda fd: fd == 71) as tty, \
                patch.object(instance, 'run') as run:
            instance.open_after_install(app, python, lib)
        self.assertIn('--defer-headless-signin', run.call_args.args[0])
        self.assertTrue(run.call_args.kwargs['console'])
        tty.assert_not_called()

    def test_desktop_auto_open_is_not_deferred_even_when_stdout_is_captured(self):
        instance, app, python, lib = self.context()
        for key, value in [('DISPLAY', ':1'), ('WAYLAND_DISPLAY', 'wayland-0')]:
            with self.subTest(key=key), patch.object(install, 'control_env', return_value={key: value}), \
                    patch.object(install, 'stdout_is_terminal', side_effect=AssertionError('desktop must not need a TTY')), \
                    patch.object(instance, 'run') as run:
                instance.open_after_install(app, python, lib)
            self.assertEqual(run.call_args.args[0][-1], 'open')
            self.assertNotIn('--defer-headless-signin', run.call_args.args[0])
            self.assertTrue(run.call_args.kwargs['console'])

    def test_stdout_pipe_or_unavailable_fileno_is_not_a_terminal(self):
        with patch.object(install.sys, 'stdout', SimpleNamespace(fileno=lambda: 72)), \
                patch.object(install.os, 'isatty', return_value=False) as tty:
            self.assertFalse(install.stdout_is_terminal())
            tty.assert_called_once_with(72)
        with patch.object(install.sys, 'stdout', io.StringIO()), \
                patch.object(install.os, 'isatty') as tty:
            self.assertFalse(install.stdout_is_terminal())
            tty.assert_not_called()


if __name__ == '__main__':
    unittest.main()


class NativePackageCompilerTests(unittest.TestCase):
    def test_native_package_sync_uses_provisioned_gcc_without_changing_other_build_environment(self):
        with tempfile.TemporaryDirectory(prefix="cc") as name:
            home = Path(name); bundle = home / "bundle"; bundle.mkdir()
            payload = bundle / "synthetic"; payload.write_bytes(b"never executed")
            root = home / ".local/share/omegahive"; calls = []
            def source(_archive, destination, rows, _prefix):
                destination.mkdir()
                for item in rows:
                    target = destination / item["path"]
                    target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(b"")
            def tool(_archive, destination):
                destination.mkdir(parents=True)
                if destination.name == "uv": (destination / "uv").write_bytes(b"never executed")
                if destination.name == "node":
                    (destination / "bin").mkdir(); (destination / "bin/node").write_bytes(b"never executed")
                if destination.name == "python":
                    (destination / "bin").mkdir(); (destination / "lib").mkdir()
                    (destination / "bin/python3.12").write_bytes(b"never executed")
            def venv(path, _source):
                path.parent.mkdir(parents=True); path.write_bytes(b"never executed"); return path
            def run(instance, argv, **kwargs):
                calls.append((list(argv), dict(kwargs.get("env", instance.env)), dict(instance.env)))
                if argv[:2] == ["/usr/bin/cmake", "--install"]:
                    prefix = root / "releases/test-1/runtime/swipl"
                    target = prefix / "lib/swipl/bin/aarch64-linux/swipl"
                    target.parent.mkdir(parents=True); target.write_bytes(b"never executed"); target.chmod(0o700)
                    launcher = prefix / "bin/swipl"; launcher.parent.mkdir()
                    launcher.symlink_to("../lib/swipl/bin/aarch64-linux/swipl")
            def ui(_archive, _manifest, destination, _provenance):
                destination.mkdir(parents=True); return b"{}"
            runtime = home / "run"; runtime.mkdir(mode=0o700)
            # A shared uv cache an earlier release left, holding a build against that release's paths.
            legacy = root / "cache/uv"; legacy.mkdir(parents=True, mode=0o700)
            (legacy / "janus_swi-built-for-test-0.whl").write_bytes(b"stale")
            with ExitStack() as stack:
                stack.enter_context(patch.dict(install.os.environ, {"CC": "clang-from-ambient", "CXX": "clang++-from-ambient", "PATH": "/untrusted"}))
                stack.enter_context(patch.object(install, "preflight", return_value="aarch64"))
                stack.enter_context(patch.object(install.Installer, "omega_core", lambda obj, app, python: None))
                stack.enter_context(patch.object(install.Installer, "code_service", lambda obj, app, python: code_record(root)))
                stack.enter_context(patch.object(install, "apparmor_enabled", return_value=True))
                stack.enter_context(patch.object(install, "validate_lock"))
                stack.enter_context(patch.object(install.Installer, "local", return_value=payload))
                stack.enter_context(patch.object(install.Installer, "fetch", return_value=payload))
                stack.enter_context(patch.object(install.Installer, "run", run))
                stack.enter_context(patch.object(install.Installer, "sudo", lambda obj, argv, package_environment=False, **kw: run(obj, ["/usr/bin/sudo", "-S", *argv], **kw)))
                stack.enter_context(patch.object(install, "extract_source", side_effect=source))
                stack.enter_context(patch.object(install, "extract_tool", side_effect=tool))
                stack.enter_context(patch.object(install, "extract_prebuilt_ui", side_effect=ui))
                stack.enter_context(patch.object(install, "extract_app", side_effect=lambda _a, d, _s: d.mkdir()))
                stack.enter_context(patch.object(install, "program_digest", return_value="sha256:" + "d" * 64))
                stack.enter_context(patch.object(install, "materialize_venv_python", side_effect=venv))
                stack.enter_context(patch.object(install, "control_env", return_value={"XDG_RUNTIME_DIR": str(runtime)}))
                install.Installer(bundle, catalogue(), home).install()
            pip_calls = [(argv, env, base) for argv, env, base in calls if argv[1:4] == ["--no-config", "pip", "sync"]]
            self.assertEqual(len(pip_calls), 1)
            argv, env, base = pip_calls[0]
            self.assertEqual(env, dict(base, CC="/usr/bin/gcc", CXX="/usr/bin/g++"))
            self.assertNotIn("CC", base); self.assertNotIn("CXX", base)
            self.assertEqual(env["PATH"], str(root / "releases/test-1/runtime/swipl/bin") + ":" + str(root / "releases/test-1/venv/bin") + ":/usr/bin:/bin")
            self.assertEqual(env["LD_LIBRARY_PATH"], str(root / "releases/test-1/runtime/python/lib"))
            self.assertEqual(env["UV_PYTHON_DOWNLOADS"], "never")
            self.assertEqual(env["UV_NO_CONFIG"], "1")
            # uv builds and caches inside this release only, and the earlier shared cache is gone.
            self.assertEqual(env["UV_CACHE_DIR"], str(root / "releases/test-1/runtime/uv-cache"))
            self.assertFalse(legacy.exists())
            self.assertTrue((root / "cache").is_dir())
            for flag in ("--python", "--require-hashes", "--require-build-hashes", "--build-constraint"):
                self.assertIn(flag, argv)
            self.assertIn("build-essential", install.APT)


class WorkingDirectoryR13Tests(unittest.TestCase):
    def test_working_directory_is_unquoted_for_plain_absolute_paths(self):
        template = ('[Service]\nExecStart=@PYTHON@ -I -B @SERVE@ --runtime @RUNTIME@\n'
                    'WorkingDirectory=@WORKDIR@\nEnvironment=@SANDBOX_ENV@\nEnvironment=@LIBPYTHON_ENV@\n')
        for component in ('plain', 'UPPER_lower-12.34'):
            with self.subTest(component=component), tempfile.TemporaryDirectory() as name:
                home = Path(name) / component; home.mkdir()
                root = home / '.local/share/omegahive'; root.mkdir(parents=True)
                app = root / 'releases/test/app'; module = app / 'deploy/linux'; module.mkdir(parents=True)
                (module / 'omegahive.service.in').write_text(template)
                (module / 'omegacode.service.in').write_text(CODE_TEMPLATE)
                instance = install.Installer(Path('/unused'), {}, home); calls = []
                instance.run = lambda argv, **kwargs: calls.append(argv)
                python = root / 'releases/test/venv/bin/python'
                descriptor = {'runtime_root': str(app.parent), 'sandbox_python': str(python),
                              'data_dir': str(root / 'data'), 'libpython_dir': None, 'code_service': code_record(root)}
                runtime = home / 'run'; runtime.mkdir(mode=0o700)
                with patch.object(install, 'control_env', return_value={'TEST': 'owned-session', 'XDG_RUNTIME_DIR': str(runtime)}):
                    instance.activate(app, python, descriptor)
                lines = (home / '.config/systemd/user/omegahive.service').read_text().splitlines()
                self.assertEqual([line for line in lines if line.startswith('WorkingDirectory=')],
                                 ['WorkingDirectory=' + str(app)])
                self.assertIn('ExecStart="' + str(python) + '" -I -B "' + str(module / 'serve.py')
                              + '" --runtime "' + str(root / 'runtime.json') + '"', lines)
                self.assertIn('Environment="HIVE_SANDBOX_PYTHON=' + str(python) + '"', lines)
                self.assertIn('Environment="LD_LIBRARY_PATH="', lines)
                self.assertEqual(calls[0], ['/usr/bin/systemd-analyze', '--user', 'verify',
                                          str(home / '.config/systemd/user/omegahive.service'),
                                          str(home / '.config/systemd/user/omegacode.service')])
                self.assertEqual(calls[-1], ['/usr/bin/systemctl', '--user', 'start', 'omegacode.service'])

    def test_working_directory_refuses_nonplain_characters_before_unit_write_or_commands(self):
        template = '[Service]\nExecStart=@PYTHON@\nWorkingDirectory=@WORKDIR@\n'
        for component in ('home with spaces', 'home"quoted', "home'quoted", r'home\backslash',
                          'home$dollar', 'home%percent', 'home\u03bb', 'home\nnewline', 'home\rcarriage'):
            with self.subTest(component=component), tempfile.TemporaryDirectory() as name:
                home = Path(name) / component; home.mkdir()
                root = home / '.local/share/omegahive'; root.mkdir(parents=True)
                app = root / 'releases/test/app'; module = app / 'deploy/linux'; module.mkdir(parents=True)
                (module / 'omegahive.service.in').write_text(template)
                (module / 'omegacode.service.in').write_text(CODE_TEMPLATE)
                calls = []
                python = root / 'releases/test/venv/bin/python'
                descriptor = {'runtime_root': str(app.parent), 'sandbox_python': str(python),
                              'data_dir': str(root / 'data'), 'libpython_dir': None, 'code_service': code_record(root)}
                message = ("home folder's name has a % sign" if '%' in component else
                           'unsupported character' if any(c in component for c in '\n\r') else
                           'installation path can use only')
                with self.assertRaisesRegex(install.Refused, message):
                    instance = install.Installer(Path('/unused'), {}, home)
                    instance.run = lambda argv, **kwargs: calls.append(argv)
                    instance.activate(app, python, descriptor)
                self.assertEqual(calls, [])
                self.assertFalse((home / '.config/systemd/user/omegahive.service').exists())

    def test_partial_uninstall_prints_existing_linger_note_for_the_current_user(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); instance, runtime = partial_fixture(home)
            data = instance.root / 'data'; data.mkdir(); (data / 'keep').write_text('retained conversation')
            output = io.StringIO()
            with patch.object(install.subprocess, 'run') as run, \
                 patch.object(install, 'APPARMOR_PROFILES', home / 'no-apparmor-profiles'), \
                 patch.object(install.pwd, 'getpwuid', return_value=SimpleNamespace(pw_name='fixture-user')), \
                 redirect_stdout(output):
                self.assertEqual(install.manage('uninstall', home), 0)
                run.assert_not_called()
            self.assertEqual(output.getvalue().splitlines(), [
                'OmegaHive is removed. Your conversations were kept in ~/.local/share/omegahive/data',
                install.LINGER_NOTE + 'fixture-user'])
            self.assertEqual((data / 'keep').read_text(), 'retained conversation')
            self.assertFalse(runtime.exists())

    def test_uninstall_names_how_to_withdraw_the_launcher_profile(self):
        with tempfile.TemporaryDirectory() as name:
            home = Path(name); _instance, _runtime = partial_fixture(home)
            profiles = home / 'apparmor.d'; profiles.mkdir()
            profile = profiles / install.launcher_profile_name(install.os.getuid()); profile.write_text('loaded')
            output = io.StringIO()
            with patch.object(install.subprocess, 'run') as run, \
                 patch.object(install, 'APPARMOR_PROFILES', profiles), \
                 patch.object(install.pwd, 'getpwuid', return_value=SimpleNamespace(pw_name='fixture-user')), \
                 redirect_stdout(output):
                self.assertEqual(install.manage('uninstall', home), 0)
                run.assert_not_called()
            self.assertEqual(output.getvalue().splitlines()[1:], [
                install.LINGER_NOTE + 'fixture-user', install.APPARMOR_NOTE.format(profile=profile)])
            self.assertIn('apparmor_parser -R ' + str(profile) + ' && sudo rm ' + str(profile), output.getvalue())
            self.assertTrue(profile.exists())


class InheritedAclTests(unittest.TestCase):
    """A parent's default ACL must not leak into the private release (seen on GitHub-hosted Ubuntu 22.04)."""
    def test_private_dir_removes_both_posix_acls_from_its_own_folder(self):
        calls = []
        with tempfile.TemporaryDirectory() as raw, \
             patch.object(install.os, 'removexattr', create=True, side_effect=lambda p, n, follow_symlinks=True: calls.append((str(p), n, follow_symlinks))):
            target = Path(raw).resolve() / 'release'
            previous = install.os.umask(0o077)
            try:
                install.private_dir(target)
            finally:
                install.os.umask(previous)
        self.assertEqual([c[1] for c in calls], ['system.posix_acl_default', 'system.posix_acl_access'])
        self.assertTrue(all(c[0] == str(target) and c[2] is False for c in calls))

    def test_missing_or_unsupported_acl_is_fine_but_other_errors_refuse(self):
        import errno as _errno
        for code, ok in ((_errno.ENODATA, True), (_errno.ENOTSUP, True), (_errno.EPERM, False), (_errno.EIO, False)):
            def fail(p, n, follow_symlinks=True, code=code):
                raise OSError(code, 'synthetic')
            with self.subTest(code=code), tempfile.TemporaryDirectory() as raw, \
                 patch.object(install.os, 'removexattr', create=True, side_effect=fail):
                if ok:
                    install.strip_inherited_acl(Path(raw))
                else:
                    with self.assertRaises(install.Refused):
                        install.strip_inherited_acl(Path(raw))


class CodeServiceTests(unittest.TestCase):
    """Create's Code service setup (Installer.code_service), checked on a synthetic omegacode release."""

    def test_module_digest_is_the_hives_own_recipe(self):
        # The hive's Code._module_digest, taken from the release's own source and run beside the installer's.
        source = (Path(__file__).parents[2] / 'hive/core/code.py').read_text()
        tree = ast.parse(source)
        code_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Code')
        method = next(n for n in code_class.body if isinstance(n, ast.FunctionDef) and n.name == '_module_digest')
        method.decorator_list = []
        namespace = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'code.py', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as name:
            package = Path(name) / 'omegacode'; (package / 'sub/__pycache__').mkdir(parents=True)
            (package / '__init__.py').write_text('A = 1\n'); (package / 'sub/b.py').write_text('B = 2\n')
            (package / 'sub/__pycache__/c.py').write_text('skipped\n'); (package / 'data.json').write_text('{}')
            self.assertEqual(install.module_digest(package), namespace['_module_digest'](package))

    def test_project_test_pin_is_the_hives_own_program_digest(self):
        # The hive runs code-project-test only when its digest matches the pin (hive/core/programs.py), so the
        # installer's independent digest of the release's own program must be the hive's, taken from its source.
        release = Path(__file__).parents[2]
        tree = ast.parse((release / 'hive/core/programs.py').read_text())
        programs = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Programs')
        method = next(n for n in programs.body if isinstance(n, ast.FunctionDef) and n.name == '_source_snapshot')
        method.decorator_list = []
        namespace = {'hashlib': hashlib}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'programs.py', 'exec'), namespace)
        plugin = release / 'hive/plugins/code_project_test'
        rows = [{'path': str(p.relative_to(plugin)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                 'mode': '100644'} for p in sorted(plugin.rglob('*')) if p.is_file() and '__pycache__' not in p.parts]
        self.assertEqual(install.program_digest(plugin, rows), namespace['_source_snapshot'](plugin)[0])

    def test_release_pins_are_read_from_the_hive_source_without_importing_it(self):
        published, portable = install.code_releases(Path(__file__).parents[2])
        self.assertRegex(published, '^[a-f0-9]{64}$'); self.assertRegex(portable, '^[a-f0-9]{64}$')
        self.assertNotEqual(published, portable)
        with tempfile.TemporaryDirectory() as name:
            (Path(name) / 'hive/core').mkdir(parents=True)
            (Path(name) / 'hive/core/code.py').write_text('PUBLISHED_SERVICE_RELEASE = "short"\n')
            with self.assertRaises(install.Refused):
                install.code_releases(Path(name))

    def synthetic(self, base):
        """A release app folder, an omegacode tarball and the two adapters, as the kit and release carry them, with the
        hive's code-project-test program and its rows in the release's source inventory."""
        app = base / 'app'; (app / 'hive/core').mkdir(parents=True); (app / 'install/macos').mkdir(parents=True)
        plugin = app / 'hive/plugins/code_project_test'; (plugin / 'tools').mkdir(parents=True)
        files = {'plugin.json': b'{"id": "code-project-test"}\n', 'program.py': b'PROGRAM = 1\n',
                 'tools/run.py': b'RUN = 1\n', 'tools/bundle.lock.json': b'{}\n'}
        rows = []
        for rel, raw in files.items():
            (plugin / rel).write_bytes(raw)
            rows.append({'path': 'hive/plugins/code_project_test/' + rel, 'bytes': len(raw),
                         'sha256': hashlib.sha256(raw).hexdigest(), 'mode': '100644'})
        rows.append(dict(rows[0], path='hive/core/code.py'))
        self.rows = rows
        package = base / 'build/omegacode'; package.mkdir(parents=True)
        (package / '__init__.py').write_text('PORT = 8724\n'); (package / '__main__.py').write_text('MODE = "published"\n')
        published = install.module_digest(package)
        archive = base / 'omegacode-309df.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(package, arcname='omegacode')
        (app / 'install/macos/omegacode-port.patch').write_text(
            '--- a/omegacode/__init__.py\n+++ b/omegacode/__init__.py\n@@ -1 +1 @@\n-PORT = 8724\n+PORT = 8725\n')
        (app / 'install/macos/omegacode-proposal-tests.patch').write_text(
            '--- a/omegacode/__main__.py\n+++ b/omegacode/__main__.py\n@@ -1 +1 @@\n-MODE = "published"\n+MODE = "portable"\n')
        (package / '__init__.py').write_text('PORT = 8725\n'); (package / '__main__.py').write_text('MODE = "portable"\n')
        portable = install.module_digest(package)
        (app / 'hive/core/code.py').write_text(f'PUBLISHED_SERVICE_RELEASE = "{published}"\nPORTABLE_SERVICE_RELEASE = "{portable}"\n')
        (app / 'install/macos/check-app.py').write_text('# the installer-owned project check\n')
        raw = archive.read_bytes()
        return app, archive, {'path': archive.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, portable

    def test_unpacks_patches_checks_and_keeps_the_release_read_only_with_its_repository_and_config(self):
        if not Path('/usr/bin/patch').exists() or not Path('/usr/bin/git').exists():
            self.skipTest('needs /usr/bin/patch and /usr/bin/git')
        with tempfile.TemporaryDirectory(prefix='code-') as name:
            base = Path(name).resolve(); home = base / 'home'; home.mkdir(mode=0o700)
            app, archive, pin, portable = self.synthetic(base)
            instance = install.Installer(base, {'code_service': pin}, home)
            instance.root.mkdir(parents=True, mode=0o700)
            instance.env = install.clean_env(home, '/usr/bin:/bin')
            with open(os.devnull, 'wb') as log:
                instance.log = log
                with patch.object(instance, 'local', return_value=archive):
                    record = instance.code_service(app, self.rows)
                    again = instance.code_service(app, self.rows)
            code = instance.root / 'code'
            plugin = app / 'hive/plugins/code_project_test'
            self.assertEqual(record, again)
            self.assertEqual(record, {'release': portable, 'root': str(code), 'config': str(code / 'config.json'),
                                      'repository': str(instance.root / 'repos/small-app'), 'port': 8724,
                                      'project_test': {'release': str(plugin), 'digest': record['project_test']['digest']}})
            # The pin covers the program's manifest and Python, not its data, by the hive's own recipe.
            digest = hashlib.sha256()
            for rel in ('plugin.json', 'program.py', 'tools/run.py'):
                digest.update(rel.encode() + b'\0' + (plugin / rel).read_bytes() + b'\0')
            self.assertEqual(record['project_test']['digest'], 'sha256:' + digest.hexdigest())
            release = code / 'releases' / portable / 'omegacode'
            self.assertEqual((release / '__init__.py').read_text(), 'PORT = 8725\n')
            self.assertFalse(any(path.stat().st_mode & 0o222 for path in release.rglob('*') if path.is_file()))
            self.assertEqual([p.name for p in (code / 'releases').iterdir()], [portable])
            for folder in ('state', 'wd', 'tmp', 'home', 'logs'):
                self.assertEqual((code / folder).stat().st_mode & 0o777, 0o700)
            self.assertEqual(list((code / 'wd').iterdir()), [])
            token = code / 'operator-token'
            self.assertEqual(token.stat().st_mode & 0o777, 0o600); self.assertGreaterEqual(len(token.read_text()), 43)
            config = json.loads((code / 'config.json').read_text())
            # Proposal tests on Linux's own sandbox: the small app runs only retained proposal snapshots, and the
            # listener those tests answer to stays off until the service is enrolled (bootstrap.py turns it on).
            self.assertEqual((config['port'], config['hive_url'], config['proposal_tests_enabled'],
                              config['sandbox_project_tests_enabled'], config['repositories']['small-app']),
                             (8724, 'http://127.0.0.1:8700', False, True,
                              {'path': str(instance.root / 'repos/small-app'), 'execution_policy': 'proposal-only'}))
            # What omegacode's registration.py leaves once the service has joined: its receipt, active.
            (code / 'state/registration.json').write_text(json.dumps({'receipt': {'status': 'active'}}))
            with open(os.devnull, 'wb') as log, patch.object(instance, 'local', return_value=archive):
                instance.log = log
                instance.code_service(app, self.rows)
            self.assertIs(json.loads((code / 'config.json').read_text())['proposal_tests_enabled'], True)
            repo = instance.root / 'repos/small-app'
            self.assertEqual(sorted(p.name for p in repo.iterdir()), ['.git', 'README.md', 'app.js', 'check_app.py', 'index.html', 'style.css'])
            log = subprocess.run(['/usr/bin/git', '-C', str(repo), 'log', '--format=%an %s'], capture_output=True, text=True,
                                 env=instance.git_env(), check=True).stdout
            self.assertEqual(log, 'Your hive Start the small app\n')

    def test_a_tarball_that_is_not_the_published_release_refuses_before_patching(self):
        with tempfile.TemporaryDirectory(prefix='code-') as name:
            base = Path(name).resolve(); home = base / 'home'; home.mkdir(mode=0o700)
            app, archive, pin, _portable = self.synthetic(base)
            # The hive accepts another published release than the tarball holds.
            portable_line = (app / 'hive/core/code.py').read_text().split('\n')[1]
            (app / 'hive/core/code.py').write_text('PUBLISHED_SERVICE_RELEASE = "' + '0' * 64 + '"\n' + portable_line + '\n')
            instance = install.Installer(base, {'code_service': pin}, home)
            instance.root.mkdir(parents=True, mode=0o700)
            commands = []
            instance.run = lambda argv, **kwargs: commands.append(argv)
            with patch.object(instance, 'local', return_value=archive), \
                    self.assertRaisesRegex(install.Refused, 'not the published release'):
                instance.code_service(app, self.rows)
            self.assertEqual(commands, [])
