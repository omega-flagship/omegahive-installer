"""Feature-preservation and submodule bootstrap tests; no model/network needed."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

import os
from unittest import mock

from hive.runtime.core import ROOT, compose, gitlink_revision, initialize, verify, verify_and_stamp


class CoreDependencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.runtime = compose(ROOT, Path(cls.temp.name) / 'runtime')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_hive_feature_implementations_are_retained(self):
        manifest = json.loads((ROOT / 'CORE_PRESERVATION.json').read_text())
        for entry in manifest['files']:
            with self.subTest(path=entry['path']):
                self.assertTrue((ROOT / entry['current_path']).is_file())
                # This manifest records the migration snapshot, not immutable
                # application content. Later edits are valid; release ZIP hashes
                # are checked separately by scripts/check_release.py.
                if entry['disposition'] == 'upstream':
                    self.assertTrue(entry['current_path'].startswith('third_party/Omega/'))
                    self.assertFalse((ROOT / entry['path']).exists())

    def test_scheduler_is_derived_from_upstream_not_old_hive_loop(self):
        from hive.runtime.native_core import prepare, adapt_loop
        dependency = verify(ROOT)
        original = (dependency / 'src/loop.metta').read_text()
        generated = prepare(ROOT).read_text()
        self.assertEqual(generated, adapt_loop(original))
        self.assertIn('(omega (+ 1 $k))', generated)
        self.assertNotIn('(omegaclaw (+ 1 $k))', generated)
        shim = (ROOT / 'lib_omegaclaw.metta').read_text()
        self.assertFalse((ROOT / 'src/loop.metta').exists())
        hooks = (ROOT / 'hive/runtime/extensions/loop_hooks.metta').read_text()
        self.assertNotIn('(omegaclaw (+ 1', shim + hooks)
        self.assertNotIn('(omega (+ 1', shim + hooks)
        self.assertIn('(omegaclaw) (omega)', shim)
        self.assertIn('(hive-cycle-end)', generated)
        self.assertIn('(command-gate $cmd)', hooks)
        self.assertIn('(save-runtime-spaces-by-role memory)', hooks)

    def test_changed_upstream_hook_sites_are_rejected(self):
        from hive.runtime.native_core import adapt_loop
        original = (verify(ROOT) / 'src/loop.metta').read_text()
        with self.assertRaisesRegex(RuntimeError, 'Upstream loop changed'):
            adapt_loop(original.replace('(heartbeat $k)', '(different-api $k)'))

    def test_custom_runtime_root_remains_supported(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(compose(Path(d), Path(d) / 'cache'), Path(d).resolve())  # macOS: /var is /private/var

    def test_workspace_refresh_preserves_agent_state(self):
        from hive.supervisor.workspace import Workspace
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            settings = SimpleNamespace(core_root=ROOT, data_dir=data, agents_dir=data / 'agents')
            workspace = Workspace(settings)
            agent = {'id': 'test', 'kind': 'omega'}
            folder = workspace.path('test')
            for name in ('memory/beliefs.metta', 'token', 'run.metta', 'memory/tools.metta'):
                path = folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('keep this: ' + name)
            workspace.refresh_runtime(agent)
            workspace.refresh_runtime(agent)
            for name in ('memory/beliefs.metta', 'token', 'run.metta', 'memory/tools.metta'):
                self.assertEqual((folder / name).read_text(), 'keep this: ' + name)
            self.assertTrue((folder / 'repos/OmegaClaw-Core/third_party/Omega/src/loop.metta').exists())

    def test_existing_real_agent_core_is_not_overwritten(self):
        from hive.supervisor.workspace import Workspace
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            workspace = Workspace(SimpleNamespace(core_root=ROOT, data_dir=data, agents_dir=data / 'agents'))
            path = workspace.path('test') / 'repos/OmegaClaw-Core'
            path.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, 'real directory'):
                workspace.refresh_runtime({'id': 'test', 'kind': 'omega'})
            self.assertTrue(path.is_dir())

    def test_docker_mounts_composed_source_read_only_and_memory_writable(self):
        from hive.supervisor.workspace import Workspace
        from hive.supervisor.drivers import DockerDriver
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            workspace = Workspace(SimpleNamespace(core_root=ROOT, data_dir=data, agents_dir=data / 'agents'))
            calls = []
            def docker(*args):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout='container')
            driver = DockerDriver(workspace)
            with patch.object(driver, 'status', return_value='absent'), patch.object(driver, '_docker', side_effect=docker), patch.object(workspace, 'chromadb_lib', return_value=data / 'chroma'):
                driver.start({'id': 'test', 'kind': 'omega'}, {})
            run = next(args for args in calls if args[0] == 'run')
            mounts = [run[i + 1] for i, arg in enumerate(run) if arg == '-v']
            self.assertIn(str(workspace.runtime_core()) + ':/agent/repos/OmegaClaw-Core:ro', mounts)
            self.assertIn(str(workspace.path('test') / 'memory') + ':/agent/memory', mounts)

    def test_fresh_clone_downloads_missing_submodule(self):
        # Exercise the real Git protocol against a local bare remote, offline.
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': d + '/cache'}):
            base = Path(d)
            parent = base / 'parent'
            parent.mkdir()
            spec = json.loads((ROOT / 'core-dependency.json').read_text())
            spec['repository'] = str(ROOT / 'third_party/Omega')
            (parent / 'core-dependency.json').write_text(json.dumps(spec))
            initialize(parent)
            self.assertEqual(verify(parent).name, 'Omega')
            self.assertFalse((parent / '.git').exists())
            # Installing from a source ZIP never creates parent Git metadata.
            self.assertFalse((parent / '.gitmodules').exists())
            subprocess.run(['git', 'init', '-q', str(parent)], check=True)
            subprocess.run(['git', '-C', str(parent), 'add', 'core-dependency.json'], check=True)
            before = (parent / '.git/index').read_bytes()
            initialize(parent)
            self.assertEqual((parent / '.git/index').read_bytes(), before)

    def test_gitlink_and_core_dependency_are_one_version(self):
        # One version source: the submodule gitlink must equal core-dependency.json in every commit.
        link = gitlink_revision(ROOT)
        if link is None:
            self.skipTest('not a git checkout with a third_party/Omega gitlink (export or ZIP tree)')
        self.assertEqual(link, json.loads((ROOT / 'core-dependency.json').read_text())['revision'])
        self.assertIn('url = https://github.com/singnet/Omega.git', (ROOT / '.gitmodules').read_text())

    def test_mind_side_verify_runs_no_git(self):
        # Minds run in the OS sandbox, where git cannot start (macOS 2026-11-05 finding). The hive process stamps.
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': d + '/cache'}):
            root = Path(d) / 'root'
            root.mkdir()
            shutil.copy(ROOT / 'core-dependency.json', root)
            subprocess.run(['git', 'clone', '-q', str(ROOT / 'third_party/Omega'), str(root / 'third_party/Omega')], check=True)
            subprocess.run(['git', '-C', str(root / 'third_party/Omega'), '-c', 'advice.detachedHead=false', 'checkout', '-q',
                            json.loads((ROOT / 'core-dependency.json').read_text())['revision']], check=True)
            with self.assertRaisesRegex(RuntimeError, 'not verified on this host'):
                verify(root, use_git=False)
            verify_and_stamp(root)
            def no_git(*args, **kwargs):
                raise AssertionError('git ran inside the mind check')
            with mock.patch('subprocess.run', no_git), mock.patch('subprocess.check_output', no_git), \
                 mock.patch('subprocess.Popen', no_git):
                self.assertEqual(verify(root, use_git=False), root / 'third_party/Omega')
                (root / 'third_party/Omega/src/loop.metta').write_text('local user work')
                with self.assertRaisesRegex(RuntimeError, 'changed since it was verified'):
                    verify(root, use_git=False)

    def test_bumped_pin_moves_a_clean_dependency(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': d + '/cache'}):
            parent = Path(d) / 'parent'
            parent.mkdir()
            spec = json.loads((ROOT / 'core-dependency.json').read_text())
            pinned = spec['revision']
            # The revision the pin is bumped from is made here, one commit on the pin in a local clone, so the test needs
            # no Omega history: CI checks submodules out at depth 1 on runners that keep their workspace between jobs,
            # and the pin's parent was then sometimes missing (omega-flagship/omegahive#108's core-tests).
            source = Path(d) / 'omega'
            subprocess.run(['git', 'clone', '-q', str(ROOT / 'third_party/Omega'), str(source)], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'advice.detachedHead=false', 'checkout', '-q', '-b', 'previous', pinned],
                           check=True)
            (source / 'PREVIOUS').write_text('only in the revision before the bump\n')
            subprocess.run(['git', '-C', str(source), 'add', 'PREVIOUS'], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit',
                            '-q', '-m', 'the revision before the bump'], check=True)
            previous = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            spec['repository'] = str(source)
            spec['revision'] = previous
            (parent / 'core-dependency.json').write_text(json.dumps(spec))
            initialize(parent)
            self.assertTrue((parent / 'third_party/Omega/PREVIOUS').exists())
            spec['revision'] = pinned
            (parent / 'core-dependency.json').write_text(json.dumps(spec))
            with self.assertRaisesRegex(RuntimeError, 'differs from core-dependency.json'):
                verify(parent, use_git=False)
            initialize(parent)
            self.assertEqual(subprocess.check_output(['git', '-C', str(parent / 'third_party/Omega'), 'rev-parse', 'HEAD'], text=True).strip(), pinned)
            self.assertFalse((parent / 'third_party/Omega/PREVIOUS').exists())

    def test_offline_install_from_a_bundle_of_the_pin(self):
        from hive.runtime.core import write_bundle
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': d + '/cache'}):
            bundle = write_bundle(ROOT, Path(d) / 'omega.bundle')
            parent = Path(d) / 'parent'
            parent.mkdir()
            shutil.copy(ROOT / 'core-dependency.json', parent)
            initialize(parent, source=bundle)
            dependency = parent / 'third_party/Omega'
            spec = json.loads((ROOT / 'core-dependency.json').read_text())
            self.assertEqual(subprocess.check_output(['git', '-C', str(dependency), 'rev-parse', 'HEAD'], text=True).strip(), spec['revision'])
            self.assertEqual(subprocess.check_output(['git', '-C', str(dependency), 'remote', 'get-url', 'origin'], text=True).strip(), spec['repository'])

    def test_short_revision_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            spec = json.loads((ROOT / 'core-dependency.json').read_text())
            spec['revision'] = spec['revision'][:12]
            (Path(d) / 'core-dependency.json').write_text(json.dumps(spec))
            with self.assertRaisesRegex(RuntimeError, 'full 40-character'):
                verify(Path(d))

    def test_dirty_dependency_is_rejected_without_reset(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            shutil.copy(ROOT / 'core-dependency.json', root)
            dependency = root / 'third_party/Omega'
            subprocess.run(['git', 'clone', '-q', str(ROOT / 'third_party/Omega'), str(dependency)], check=True)
            path = dependency / 'src/loop.metta'
            path.write_text('local user work')
            with self.assertRaisesRegex(RuntimeError, 'local changes'):
                verify(root)
            self.assertEqual(path.read_text(), 'local user work')


if __name__ == '__main__':
    unittest.main()
