"""Purpose: verify the hive prepares once and minds only hash prepared runtime files."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hive.runtime.core import ROOT
from hive.runtime import native_core
from hive.supervisor.workspace import Workspace


class RuntimeVerificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        environment = patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': temporary.name})
        environment.start()
        self.addCleanup(environment.stop)
        native_core.prepare(ROOT)

    def test_every_rendered_file_has_a_hash_including_the_foundation(self):
        receipt = json.loads((self.directory / 'singnet-core.json').read_text())
        # every rendered file has a hash; the receipt itself and the hive's dependency stamp are not rendered files
        from hive.runtime.core import STAMP
        self.assertEqual(set(receipt), {p.name for p in self.directory.iterdir()} - {'singnet-core.json', STAMP})
        self.assertIn('singnet-foundation.metta', receipt)
        for name, row in receipt.items():
            with self.subTest(name=name):
                self.assertEqual(row['runtime_sha256'], hashlib.sha256((self.directory / name).read_bytes()).hexdigest())

    def test_paths_need_neither_git_nor_upstream_sources(self):
        with patch('hive.runtime.core.verify', side_effect=AssertionError('Git in mind')), \
             patch.object(native_core, '_render', side_effect=AssertionError('render in mind')):
            # the runtime directory is resolved (macOS: /var is /private/var)
            directory = self.directory.resolve()
            self.assertEqual(native_core.foundation_path(), str(directory / 'singnet-foundation.metta'))
            self.assertEqual(native_core.loop_path(), str(directory / 'native-src-loop.metta'))

    def test_bootstrap_needs_neither_git_nor_upstream_rendering(self):
        program = '''from unittest.mock import patch
from hive.runtime.native_core import bootstrap
with patch('hive.runtime.core.verify', side_effect=AssertionError('Git in mind')), \\
     patch('hive.runtime.native_core._render', side_effect=AssertionError('render in mind')):
    assert bootstrap()
'''
        result = subprocess.run([sys.executable, '-c', program], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_each_rendered_file_is_checked_on_every_call(self):
        receipt = json.loads((self.directory / 'singnet-core.json').read_text())
        for name in receipt:
            with self.subTest(name=name):
                path = self.directory / name
                original = path.read_bytes()
                native_core.foundation_path()
                path.write_bytes(original + b'\nchanged')
                with self.assertRaisesRegex(RuntimeError, 'missing or stale Singnet composition'):
                    native_core.loop_path()
                path.write_bytes(original)
                path.unlink()
                with self.assertRaisesRegex(RuntimeError, 'missing or stale Singnet composition'):
                    native_core.foundation_path()
                path.write_bytes(original)

    def test_invalid_receipts_fail_closed(self):
        path = self.directory / 'singnet-core.json'
        original = path.read_text()
        invalid = ['{', '[]', '{}', json.dumps({'singnet-foundation.metta': {}}),
                   json.dumps({'singnet-foundation.metta': None}),
                   json.dumps({'../outside': {}, 'singnet-foundation.metta': {}})]
        for text in invalid:
            with self.subTest(receipt=text):
                path.write_text(text)
                with self.assertRaisesRegex(RuntimeError, 'missing or stale Singnet composition'):
                    native_core.foundation_path()
        path.write_text(original)
        path.unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing or stale Singnet composition'):
            native_core.foundation_path()


class HivePreparationTests(unittest.TestCase):
    def workspace(self):
        return Workspace(SimpleNamespace(core_root=ROOT, data_dir=ROOT / 'unused-data'))

    def test_concurrent_mind_starts_prepare_the_core_once(self):
        workspace = self.workspace()
        with patch('hive.runtime.core.compose', return_value=ROOT) as compose:
            with ThreadPoolExecutor(max_workers=8) as pool:
                roots = list(pool.map(lambda _: workspace.runtime_core(), range(16)))
            self.assertEqual(roots, [ROOT] * 16)
            compose.assert_called_once_with(ROOT, ROOT / 'unused-data/libs/omega-runtime')

    def test_failed_preparation_is_not_cached(self):
        workspace = self.workspace()
        with patch('hive.runtime.core.compose', side_effect=[RuntimeError('dirty dependency'), ROOT]) as compose:
            with self.assertRaisesRegex(RuntimeError, 'dirty dependency'):
                workspace.runtime_core()
            self.assertEqual(workspace.runtime_core(), ROOT)
            self.assertEqual(workspace.runtime_core(), ROOT)
            self.assertEqual(compose.call_count, 2)
