"""Extraction and copy-over upgrade contracts for the complete V7 composition."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from hive.runtime.core import ROOT
from hive.runtime.migration import retire
from hive.runtime.native_core import prepare, runtime_directory


class FullCoreCompositionTests(unittest.TestCase):
    def test_every_core_service_is_generated_from_pinned_upstream(self):
        prepare(ROOT)
        receipt = json.loads((runtime_directory(ROOT)/'singnet-core.json').read_text())
        for name in ('utils', 'config', 'providers', 'channels', 'plugin', 'skills', 'memory', 'loop'):
            key = 'native-src-' + name + '.metta'
            row = receipt[key]
            self.assertEqual(row['source_sha256'], hashlib.sha256((ROOT/'third_party/Omega'/row['upstream']).read_bytes()).hexdigest())
            self.assertEqual(row['runtime_sha256'], hashlib.sha256((runtime_directory(ROOT)/key).read_bytes()).hexdigest())

    def test_retired_implementations_have_no_fallback_files(self):
        for name in json.loads((ROOT/'CORE_RETIRED_FILES.json').read_text()):
            self.assertFalse((ROOT/name).exists(), name)
        self.assertNotIn('useGPT ', (ROOT/'hive/runtime/extensions/loop_hooks.metta').read_text())
        self.assertNotIn('callProvider', (ROOT/'hive/runtime/hive_services.py').read_text())

    def test_python_services_resolve_to_dependency(self):
        program = '''from hive.runtime.native_core import bootstrap, ROOT
bootstrap()
import config, providers, channels, plugin, fileio, lib_llm_ext, utils
from pathlib import Path
for module in (config, providers, channels, plugin, fileio, lib_llm_ext, utils):
    assert Path(module.__file__).resolve().is_relative_to(ROOT/'third_party/Omega'), module.__file__
'''
        result = subprocess.run([sys.executable, '-c', program], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_copy_over_removes_only_recognized_retired_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'old.metta').write_text('old core')
            (root/'keep.md').write_text('feature docs')
            digest = hashlib.sha256(b'old core').hexdigest()
            (root/'CORE_RETIRED_FILES.json').write_text(json.dumps({'old.metta':[digest]}))
            self.assertEqual(retire(root), ['old.metta'])
            self.assertFalse((root/'old.metta').exists())
            self.assertEqual((root/'keep.md').read_text(), 'feature docs')
            self.assertEqual(retire(root), [])

    def test_copy_over_preflights_all_files_before_any_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'one').write_text('known')
            (root/'two').write_text('user changed this')
            digest = hashlib.sha256(b'known').hexdigest()
            (root/'CORE_RETIRED_FILES.json').write_text(json.dumps({'one':[digest], 'two':[digest]}))
            with self.assertRaisesRegex(RuntimeError, 'nothing removed'):
                retire(root)
            self.assertTrue((root/'one').exists())
            self.assertEqual((root/'two').read_text(), 'user changed this')
