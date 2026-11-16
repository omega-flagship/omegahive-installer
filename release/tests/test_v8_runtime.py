"""Purpose: regressions for the V8 review, with no live models or network calls."""
import io
import logging
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from hive.runtime.core import ROOT
from hive.runtime.native_core import prepare, runtime_directory


class V8RuntimeTests(unittest.TestCase):
    def test_unlisted_native_skills_require_approval(self):
        from hive.core.policy import Policy
        policy = Policy.__new__(Policy)
        policy.hive, policy.db, policy.recent = SimpleNamespace(), None, {}
        policy.rules = policy.all_rules = lambda: []
        for skill in ('delete-file', 'remove-skill', 'add-skill', 'future-native-action', 'code-future-action'):
            self.assertEqual(policy.decide({'id': 'test'}, skill)[0], 'ask')
        for skill in ('generate-image', 'generate-image-quality'):    # each image spends money (omega-flagship/omegahive#230)
            self.assertEqual(policy.decide({'id': 'test'}, skill)[0], 'ask')
        for skill in ('read-file', 'repo-query', 'query-skill-space', 'explain-skill'):
            self.assertEqual(policy.decide({'id': 'test'}, skill)[0], 'allow')

    def test_config_values_never_reach_debug_or_direct_handlers(self):
        from hive.runtime.logging_privacy import protect_config_logger
        logger = logging.getLogger('config')
        old_level = logger.level
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            protect_config_logger()
            logger.info('Configuration item: token=%s', 'synthetic-secret')
            try:
                raise ValueError('synthetic-secret')
            except ValueError:
                logger.exception('synthetic-secret')
            self.assertNotIn('synthetic-secret', stream.getvalue())
            self.assertIn('values suppressed', stream.getvalue())
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)

    def test_runtime_writes_only_to_external_cache_and_reuses_files(self):
        legacy = ROOT / '.runtime'
        def legacy_snapshot():
            if not legacy.exists():
                return None
            return {str(p.relative_to(legacy)): (p.lstat().st_size, p.lstat().st_mtime_ns)
                    for p in [legacy, *legacy.rglob('*')]}
        before = legacy_snapshot()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': tmp}):
                first = prepare(ROOT)
                mtimes = {p.name: p.stat().st_mtime_ns for p in Path(tmp).iterdir()}
                self.assertEqual(first.parent, Path(tmp).resolve())  # macOS: /var is /private/var
                prepare(ROOT)
                self.assertEqual(mtimes, {p.name: p.stat().st_mtime_ns for p in Path(tmp).iterdir()})
                self.assertEqual(before, legacy_snapshot(),
                                 'prepare() modified the legacy in-tree runtime directory')
                for p in Path(tmp).glob('*.metta'):
                    self.assertNotIn('./.runtime/', p.read_text())

    def test_format_errors_retry_soon_transport_errors_back_off(self):
        from hive.runtime import hive_services
        # Use the real upstream response types and validation through bootstrap.
        from hive.runtime.native_core import bootstrap
        prepare(ROOT)
        bootstrap()
        import providers
        from hive.runtime.extensions.hive_helpers import chosen_wait_seconds
        malformed = providers.LLMResponse().add_tool_call(providers.LLMToolCall().with_error('Invalid JSON'))
        outage = providers.LLMResponse().with_error('Connection unavailable')
        for result, marker, kind, seconds in ((malformed, 'LLM-FORMAT-ERROR', 'format', 2),
                                              (outage, 'LLM-PROVIDER-ERROR', 'provider', 60)):
            with patch.object(providers, 'llmProviderChat', return_value=result), patch.object(hive_services, '_PROVIDER_ERROR', None), patch.object(providers, '_llmprovider', None):
                answer = hive_services.chat(None)
            text = answer.calls[0].arguments['text']
            self.assertIn(marker, text)
            # The retry credit comes from the runtime's provenance, not from the marker text.
            self.assertEqual(hive_services.last_response_kind(), kind)
            self.assertEqual(chosen_wait_seconds('((' + text + '))', kind, 1), seconds)
        self.assertEqual(chosen_wait_seconds('((wait "LLM-FORMAT-ERROR model text"))'), 0)

    def test_default_installer_uses_local_source_without_hive_clone(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('v8_installer', ROOT/'install/installer_common.py')
        installer = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = installer
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            with patch.object(installer, 'require_tool'), patch.object(installer, 'clone_or_bootstrap_workspace'), \
                 patch.object(installer, 'clone_or_update') as clone, patch.object(installer, 'write_root_run'), \
                 patch.object(installer.subprocess, 'run'):
                core = installer.prepare_workspace(work, None)
            self.assertTrue((core/'modules/channel_whatsapp/src/whatsapp.py').is_file())
            self.assertTrue((core/'core-dependency.json').is_file())
            self.assertEqual([call.args[0] for call in clone.call_args_list], [installer.CHROMA_URL])
            self.assertFalse((core/'.git').exists())

    def test_only_upstream_defines_add_skill(self):
        import re
        definition = re.compile(r'\(=\s*\(add-skill\s')
        own = [p for p in (ROOT/'hive/runtime/extensions').glob('*.metta') if definition.search(p.read_text())]
        self.assertEqual(own, [])
        self.assertEqual(len(definition.findall((ROOT/'third_party/Omega/src/skills.metta').read_text())), 1)


if __name__ == '__main__':
    unittest.main()
