"""Review fixes for the #49 native core: the mock model answers the transport tool, websearch asks the hive, minds load
only the host's module loader, and a model that refuses tools falls back to plain text."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


class _NativeCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from hive.runtime.native_core import prepare, bootstrap
        prepare(ROOT)
        bootstrap()

    def setUp(self):
        import providers, lib_llm_ext, config
        from hive.runtime import hive_services as services
        self.services, self.providers, self.native = services, providers, lib_llm_ext
        services._INITIALIZED = False
        services.initialize([])
        config._CONFIG.clear()

    def request(self, prompt):
        from hive.runtime.hive_provider import tools
        p = self.providers
        return (p.LLMRequest().with_messages([p.LLMMessage().with_role('system').with_content('You are a mind.'),
                                              p.LLMMessage().with_role('user').with_content(prompt)])
                .with_tools(tools()).with_max_tokens(256))

    def prepared(self, text, kind):
        from hive.runtime.extensions import hive_helpers as h
        envelope = h.prepare_model_response(text, kind)
        return h.prepared_response_commands(envelope), h.prepared_response_kind(envelope)


class _GatewayClient:
    """The mind's OpenAI client, answered in-process by the hive's real Gateway (mock provider): no fake server."""
    requests = []

    def __init__(self, **kwargs):
        from hive.core.config import Provider
        from hive.core.gateway import Gateway
        self.gateway = Gateway({'mock': Provider('mock', models=['echo'], local=True)})
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **body):
        from openai.types.chat import ChatCompletion
        self.requests.append(body)
        agent = {'id': 'a_mock', 'name': 'mocky', 'model': 'mock/echo', 'swarm_id': 's_test'}
        data, _usage = asyncio.run(self.gateway.chat(agent, body))
        return ChatCompletion.model_validate(data)

    def close(self):
        pass


class MockModelThroughGatewayTests(_NativeCase):
    def chat(self, prompt):
        _GatewayClient.requests.clear()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'HIVE_LLM_TOKEN': 'synthetic-mind-token', 'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(self.native.openai, 'OpenAI', _GatewayClient), \
             mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            self.services.start_provider('Hive', 'hive')
            result = self.services.chat(self.request(prompt))
        return result, self.services.last_response_kind()

    def test_mock_answers_a_human_message_through_the_transport_tool(self):
        result, kind = self.chat('(HUMAN-MSG: hello there)')
        self.assertTrue(_GatewayClient.requests and _GatewayClient.requests[-1]['tools'], 'the transport tool is offered')
        self.assertEqual(kind, 'normal')
        self.assertEqual([call.name for call in result.calls], ['hive-run-response'])
        text = result.calls[0].arguments['text']
        self.assertEqual(text, 'send I hear you - "hello there"')
        commands, retry = self.prepared(text, kind)
        self.assertEqual(retry, 'normal')
        self.assertIn('send', commands)
        self.assertNotIn('LLM-FORMAT-ERROR', commands)

    def test_mock_without_new_input_waits_and_is_never_a_format_failure(self):
        result, kind = self.chat('nothing new')
        self.assertEqual(kind, 'normal')
        self.assertEqual(result.calls[0].arguments['text'], 'wait idle')

    def test_iter_style_tool_mock_is_unchanged(self):
        from hive.core.gateway import mock_tool_reply
        body = {'tools': [{'type': 'function', 'function': {'name': 'nop'}}],
                'messages': [{'role': 'user', 'content': 'tick'}]}
        calls = mock_tool_reply('iter', body)['choices'][0]['message']['tool_calls']
        self.assertEqual([c['function']['name'] for c in calls], ['nop'])


class WebsearchThroughTheHiveTests(unittest.TestCase):
    """The upstream websearch skill searched from inside the mind (ddgs); it now asks the hive like web-search."""

    def test_bootstrap_loads_the_hive_client_and_never_upstream_websearch(self):
        source = (ROOT / 'hive/runtime/native_core.py').read_text()
        self.assertNotIn("'src'/'websearch.py'", source)
        self.assertNotIn("_load_optional_websearch", source)
        self.assertIn("load('hive_web',ROOT/'modules'/'web_search'/'src'/'hive_web.py')", source)

    def test_rendered_websearch_skill_calls_the_hive_client(self):
        from hive.runtime import native_core
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {'OMEGACLAW_RUNTIME_CACHE': temporary}):
            native_core.prepare(ROOT)
            skills = (Path(temporary) / 'native-src-skills.metta').read_text()
        self.assertIn('(= (websearch $msg)\n   (py-call (hive_web.search $msg)))', skills)
        self.assertNotIn('websearch.search', skills)

    def test_the_websearch_replacement_fails_closed_when_upstream_changes(self):
        from hive.runtime import native_core
        with self.assertRaisesRegex(RuntimeError, 'Upstream loop changed'):
            native_core._replace('(= (websearch $q) (py-call (websearch.search $q)))',
                                 '(= (websearch $msg)\n   (py-call (websearch.search $msg)))', 'x')

    def test_the_mind_image_does_not_install_ddgs_but_the_host_does(self):
        self.assertNotIn('ddgs', (ROOT / 'Dockerfile').read_text())
        self.assertIn('ddgs==', (ROOT / 'hive/requirements.txt').read_text())


class HostModuleLoaderTests(unittest.TestCase):
    def test_workspace_loader_is_never_used_and_parser_agrees(self):
        from hive.runtime import hive_services
        from hive.runtime.extensions import helper_command_parser as parser
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / 'local').mkdir()
            planted = workspace / 'local' / 'modules-loader.metta'
            planted.write_text('!(import! &self (library OmegaClaw-Core ./modules/agentverse/entry.metta))\n')
            cwd = os.getcwd()
            os.chdir(workspace)
            try:
                with mock.patch.dict(os.environ, {'OMEGACLAW_MEMORY_DIR': str(workspace / 'memory')}, clear=False):
                    os.environ.pop('OMEGACLAW_MODULE_LOADER', None)
                    loaded = Path(hive_services.module_loader())
                    authorized = parser._active_module_loader_paths()
                    running, off = parser.module_selection(authorized[0])
                    imported = parser._enabled_module_names(loaded)
            finally:
                os.chdir(cwd)
        self.assertEqual([Path(p).resolve() for p in authorized], [(ROOT / 'modules' / 'loader.metta').resolve()])
        # the host loader itself, or its copy less the modules this mind lacks requirements for (module_selection)
        self.assertEqual(loaded, ROOT / 'modules' / 'loader.metta' if not off else workspace / 'memory' / 'modules-loader.metta')
        self.assertEqual(imported, running)
        self.assertNotEqual(loaded.resolve(), planted.resolve())
        self.assertNotIn('agentverse', imported)

    def test_host_env_loader_is_loaded_and_authorized(self):
        from hive.runtime import hive_services
        from hive.runtime.extensions import helper_command_parser as parser
        with tempfile.TemporaryDirectory() as tmp:
            host = Path(tmp) / 'host-loader.metta'
            host.write_text('; no modules\n')
            with mock.patch.dict(os.environ, {'OMEGACLAW_MODULE_LOADER': str(host)}):
                self.assertEqual(Path(hive_services.module_loader()), host.resolve())
                self.assertEqual(parser._active_module_loader_paths(), [host.resolve()])
            with mock.patch.dict(os.environ, {'OMEGACLAW_MODULE_LOADER': str(Path(tmp) / 'missing.metta')}):
                with self.assertRaises(FileNotFoundError):
                    hive_services.module_loader()
                self.assertEqual(parser._active_module_loader_paths(), [])


class _ToolRefusingClient:
    """An Ollama-style server for a model without tool support: a tool request is HTTP 400, plain text works."""
    requests = []

    def __init__(self, **kwargs):
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **body):
        import httpx
        import openai
        self.requests.append(body)
        if body.get('tools'):
            request = httpx.Request('POST', 'http://127.0.0.1:11434/v1/chat/completions')
            response = httpx.Response(400, request=request,
                                      json={'error': {'message': 'registry.ollama.ai/library/tiny:1b does not support tools'}})
            raise openai.BadRequestError('Error code: 400 - tiny:1b does not support tools', response=response,
                                         body=None)
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content='send "plain text works"', tool_calls=None), finish_reason='stop')],
            model=body['model'], usage=None)

    def close(self):
        pass


class TextOnlyFallbackTests(_NativeCase):
    def test_model_without_tools_falls_back_to_text_once_and_stays_there(self):
        _ToolRefusingClient.requests.clear()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'OLLAMA_API_KEY': 'synthetic-local', 'OMEGACLAW_MEMORY_DIR': tmp,
                                          'LLM_SERVER_LOCAL_URL': 'http://127.0.0.1:11434'}), \
             mock.patch.object(self.native.openai, 'OpenAI', _ToolRefusingClient), \
             mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            self.services.start_provider('Ollama-local', 'tiny:1b')
            first = self.services.chat(self.request('(HUMAN-MSG: hi)'))
            kind = self.services.last_response_kind()
            second = self.services.chat(self.request('(HUMAN-MSG: again)'))
        self.assertEqual(kind, 'normal')
        self.assertEqual(first.calls[0].arguments['text'], 'send "plain text works"')
        self.assertEqual(second.calls[0].arguments['text'], 'send "plain text works"')
        offered = [bool(r.get('tools')) for r in _ToolRefusingClient.requests]
        self.assertEqual(offered, [True, False, False])

    def test_other_errors_never_drop_tools(self):
        from hive.runtime.provider_features import tools_unsupported
        self.assertTrue(tools_unsupported('Error code: 400 - x does not support tools'))
        self.assertFalse(tools_unsupported('Error code: 500 - x does not support tools'))
        self.assertFalse(tools_unsupported('Error code: 400 - context length exceeded'))
        self.assertFalse(tools_unsupported(None))


class DoctorRuntimeCacheTests(unittest.TestCase):
    def test_doctor_reads_the_cache_native_core_writes(self):
        import importlib.util
        from hive.runtime.native_core import runtime_directory
        spec = importlib.util.spec_from_file_location('doctor_under_test', ROOT / 'install' / 'doctor.py')
        doctor = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(ROOT / 'install'))
        try:
            spec.loader.exec_module(doctor)
        finally:
            sys.path.remove(str(ROOT / 'install'))
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {'XDG_CACHE_HOME': tmp}):
                os.environ.pop('OMEGACLAW_RUNTIME_CACHE', None)
                self.assertEqual(doctor.runtime_cache(ROOT, {}), runtime_directory(ROOT))
            self.assertEqual(doctor.runtime_cache(ROOT, {'OMEGACLAW_RUNTIME_CACHE': tmp}), Path(tmp).resolve())


class DockerContextTests(unittest.TestCase):
    def test_prompt_seed_is_in_the_image_context(self):
        lines = [l.strip() for l in (ROOT / '.dockerignore').read_text().splitlines()]
        self.assertIn('chmod 0444 ${MEMORY_DIR}/prompt.txt', (ROOT / 'Dockerfile').read_text())
        self.assertIn('memory/', lines)
        self.assertNotIn('!memory/prompt.txt', lines)
        self.assertIn('cp ${OMEGACLAW_DIR}/src/base_prompt.txt ${MEMORY_DIR}/prompt.txt',
                      (ROOT / 'Dockerfile').read_text())
        self.assertTrue((ROOT / 'src' / 'base_prompt.txt').is_file())


if __name__ == '__main__':
    unittest.main()
