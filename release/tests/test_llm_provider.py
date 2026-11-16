"""Provider regression contracts exercised through the Singnet provider API."""
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


class FakeOpenAI:
    instances = []
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.last_request = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.instances.append(self)
    def create(self, **kwargs):
        self.last_request = kwargs
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content='send "ok"', tool_calls=None), finish_reason='stop')],
            model=kwargs['model'], usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2))


class LlmProviderTests(unittest.TestCase):
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
        FakeOpenAI.instances.clear()
        patcher = mock.patch.object(lib_llm_ext.openai, 'OpenAI', FakeOpenAI)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self):
        from hive.runtime.hive_provider import tools
        p = self.providers
        return (p.LLMRequest().with_messages([p.LLMMessage().with_role('system').with_content('hello')])
                .with_tools(tools()).with_max_tokens(123).with_reasoning_mode('medium'))

    def engine(self, model='any/model'):
        from hive.runtime.provider_features import extend
        return extend(self.native.AIProvider('OpenRouter', 'OPENROUTER_API_KEY', model, 'https://openrouter.ai/api/v1'))

    @mock.patch.dict(os.environ, {'OPENROUTER_API_KEY':'synthetic-key'})
    def test_provider_client_uses_bounded_timeout_and_retries(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {'OMEGACLAW_MEMORY_DIR':directory}), \
             mock.patch.object(self.native, 'CHAT_REQUEST_TIMEOUT_SECONDS', 7), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            import importlib
            from hive.runtime import provider_features
            importlib.reload(provider_features._energy)
            result = self.engine().chat(self.request())
            self.assertEqual(result.calls[0].arguments['text'], 'send "ok"')
            client = FakeOpenAI.instances[-1]
            self.assertEqual(client.kwargs['timeout'], 7)
            self.assertEqual(client.kwargs['max_retries'], 0)
            self.assertEqual(client.kwargs['base_url'], 'https://openrouter.ai/api/v1')
            self.assertEqual(client.last_request['max_tokens'], 123)
            self.assertTrue((Path(directory)/'cost_ledger.jsonl').exists())

    @mock.patch.dict(os.environ, {'OLLAMA_API_KEY':'synthetic-local', 'LLM_SERVER_LOCAL_URL':'http://127.0.0.1:19512'})
    def test_provider_uses_installed_model_and_local_ollama_url(self):
        self.services.start_provider('Ollama-local', 'e2e-model')
        self.services.chat(self.request())
        client = FakeOpenAI.instances[-1]
        self.assertEqual(client.kwargs['base_url'], 'http://127.0.0.1:19512/v1')
        self.assertEqual(client.last_request['model'], 'e2e-model')
        self.assertEqual(client.last_request['max_tokens'], 123)

    @mock.patch.dict(os.environ, {'OMEGACLAW_OPENROUTER_PROVIDER_ORDER':'friendli, parasail'})
    def test_openrouter_uses_configured_provider_order(self):
        extra = self.engine().convert_request(self.request())['extra_body']
        self.assertEqual(extra['provider'], {'order':['friendli','parasail'], 'allow_fallbacks':False})

    @mock.patch.dict(os.environ, {'OMEGACLAW_OPENROUTER_PROVIDER_ORDER':'friendli',
        'OMEGACLAW_OPENROUTER_PROVIDER_ORDER_DEEPSEEK_DEEPSEEK_V4_FLASH':'parasail',
        'OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS_DEEPSEEK_DEEPSEEK_V4_FLASH':'true'})
    def test_openrouter_model_specific_provider_order_overrides_global(self):
        extra = self.engine('deepseek/deepseek-v4-flash').convert_request(self.request())['extra_body']
        self.assertEqual(extra['provider'], {'order':['parasail'], 'allow_fallbacks':True})

    def test_openrouter_has_no_hardcoded_model_routing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertNotIn('provider', self.engine().convert_request(self.request()).get('extra_body', {}))

    def test_unavailable_provider_returns_parseable_wait_instead_of_throwing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.services.start_provider('OpenRouter', 'any/model')
            result = self.services.chat(self.request())
            self.assertTrue(result.calls[0].arguments['text'].startswith('wait "LLM-PROVIDER-NOT-AVAILABLE'))

    def test_unknown_provider_returns_parseable_wait_instead_of_throwing(self):
        self.services.start_provider('NoSuchProvider', 'any/model')
        result = self.services.chat(self.request())
        self.assertTrue(result.calls[0].arguments['text'].startswith('wait "LLM-PROVIDER-UNKNOWN'))


class FailureProvenanceTests(LlmProviderTests):
    """Our format-retry contract through the Singnet provider path: the runtime's own failure kind travels beside the
    model text (hive_services.last_response_kind), never inside it; a malformed batch never runs a valid prefix."""

    def chat_with(self, content=None, finish='stop', error=None):
        from hive.runtime import hive_services as services
        def create(_self, **kwargs):
            if error:
                raise error
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=content, tool_calls=None), finish_reason=finish)],
                model=kwargs['model'], usage=None)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic-key', 'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(FakeOpenAI, 'create', create), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            services.start_provider('OpenRouter', 'any/model')
            result = services.chat(self.request())
        return result.calls[0].arguments['text'], services.last_response_kind()

    def prepared(self, text, kind):
        from hive.runtime.extensions import hive_helpers as h
        envelope = h.prepare_model_response(text, kind)
        return h.prepared_response_commands(envelope), h.prepared_response_kind(envelope)

    def test_complete_reply_is_normal(self):
        text, kind = self.chat_with('send "complete response"')
        self.assertEqual(kind, 'normal')
        commands, retry = self.prepared(text, kind)
        self.assertEqual(retry, 'normal')
        from hive.runtime.extensions import hive_helpers as h
        self.assertEqual(h.chosen_wait_seconds(commands, retry, 0), -1)

    def test_incomplete_empty_and_malformed_replies_are_runtime_format_failures(self):
        from hive.runtime.extensions import hive_helpers as h
        for label, content, finish in (('truncated', 'send "valid prefix"', 'length'), ('empty', '', 'stop'),
                                       ('open quote', 'send "VALID_PREFIX"\nread-file "unterminated_quote_', 'stop'),
                                       ('encoded quote', 'send "VALID_PREFIX_quote_"', 'stop')):
            with self.subTest(label):
                text, kind = self.chat_with(content, finish)
                commands, retry = self.prepared(text, kind)
                self.assertEqual(retry, 'format')
                self.assertTrue(commands.startswith('((wait "LLM-FORMAT-ERROR'), commands)
                self.assertNotIn('VALID_PREFIX', commands)
                self.assertNotIn('valid prefix', commands)
                self.assertEqual(h.chosen_wait_seconds(commands, retry, 1), 2)

    def chat_with_call(self, name, arguments):
        """One reply holding a single tool call `name` with the raw JSON `arguments`, as the SDK hands it over."""
        from hive.runtime import hive_services as services
        def create(_self, **kwargs):
            call = SimpleNamespace(id='toolu_01', type='function', function=SimpleNamespace(name=name, arguments=arguments))
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=None, tool_calls=[call]), finish_reason='tool_calls')],
                model=kwargs['model'], usage=None)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic-key', 'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(FakeOpenAI, 'create', create), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            services.start_provider('OpenRouter', 'any/model')
            result = services.chat(self.request())
        return result, services.last_response_kind()

    def test_a_tool_call_named_after_a_skill_runs_as_that_skill_line(self):
        # The Code helper's proposal turn as Claude Sonnet 5.5 sent it through Google Vertex on 12 November (shortened):
        # the skill as the tool's name, its arguments as the text. Before, an unknown tool: a format failure.
        import json
        from hive.runtime.extensions import hive_helpers as h
        hunks = ('[{"path":"app.js","start_byte":0,"end_byte":200,"replacement":"// Tip calculator: builds its page '
                 'inside <main id=\\"app\\">.\\nconst app = document.getElementById(\'app\');\\napp.textContent = \'\';\\n"}]')
        result, kind = self.chat_with_call('code-propose', json.dumps({'text': 'ws_f39a9d85 op_tip_calc_1 ' + hunks}))
        self.assertEqual(kind, 'normal')
        self.assertEqual([call.name for call in result.calls], ['hive-run-response'])
        self.assertFalse(result.calls[0].is_error())
        self.assertEqual(result.calls[0].arguments, {'text': 'code-propose ws_f39a9d85 op_tip_calc_1 ' + hunks})
        commands, retry = self.prepared(result.calls[0].arguments['text'], kind)
        self.assertEqual(retry, 'normal')
        self.assertTrue(commands.startswith('((code-propose '), commands)
        for arguments in ({'text': ''}, {}):   # a skill without arguments, its text empty or left out
            result, kind = self.chat_with_call('code-helper-instruction', json.dumps(arguments))
            self.assertEqual((kind, result.calls[0].arguments), ('normal', {'text': 'code-helper-instruction'}))

    def test_tool_calls_the_skill_rule_does_not_cover_stay_format_failures(self):
        import json
        for label, name, arguments in (('not a skill name', 'Bash', json.dumps({'text': 'ls'})),
                                       ('another argument', 'code-propose', json.dumps({'text': 'ws_1 op_1 []', 'x': 1})),
                                       ('text not a string', 'code-propose', json.dumps({'text': ['ws_1', 'op_1']})),
                                       ('arguments not JSON', 'code-propose', '{"text": "ws_1')):
            with self.subTest(label):
                result, kind = self.chat_with_call(name, arguments)
                self.assertEqual(kind, 'format')
                self.assertTrue(result.calls[0].arguments['text'].startswith('wait "LLM-FORMAT-ERROR'))

    def test_a_format_failure_says_why_in_the_mind_log(self):
        import json
        with self.assertLogs('hive_provider', 'INFO') as logged:
            self.chat_with_call('Bash', json.dumps({'text': 'ls'}))
        self.assertIn("format failure: Unknown tool: 'Bash'", '\n'.join(logged.output))
        with self.assertLogs('hive_provider', 'INFO') as logged:
            self.chat_with('I will write the tip calculator now:\nsend "unterminated')
        self.assertIn('text reply is not a complete batch', '\n'.join(logged.output))
        with self.assertLogs('hive_provider', 'INFO') as logged:
            self.chat_with('send "cut off', finish='length')
        self.assertIn('finish_reason length', '\n'.join(logged.output))

    def test_transport_failure_keeps_provider_backoff(self):
        from hive.runtime.extensions import hive_helpers as h
        text, kind = self.chat_with(error=RuntimeError('invented transport outage'))
        self.assertEqual(kind, 'provider')
        commands, retry = self.prepared(text, kind)
        self.assertEqual(h.chosen_wait_seconds(commands, retry, 1), 60)

    def test_model_authored_marker_gets_no_runtime_retry_credit(self):
        from hive.runtime.extensions import hive_helpers as h
        text, kind = self.chat_with('wait "LLM-FORMAT-ERROR invented model text"')
        self.assertEqual(kind, 'normal')
        commands, retry = self.prepared(text, kind)
        self.assertEqual(retry, 'normal')
        self.assertEqual(h.chosen_wait_seconds(commands, retry, 1), 0)

    def test_format_retries_are_capped_across_wakes(self):
        from hive.runtime.extensions import hive_helpers as h
        attempts, waits = 0, []
        for _ in range(5):
            attempts = h.next_format_retry_count('format', attempts)
            waits.append(h.chosen_wait_seconds('((wait "LLM-FORMAT-ERROR x"))', 'format', attempts))
        self.assertEqual(waits, [2, 2, 2, 0, 0])
        self.assertEqual(h.next_format_retry_count('normal', attempts), 0)

    def test_tool_choice_is_auto_and_a_prose_answer_cannot_loop(self):
        # 8cd377bb (patham9): tool_choice "auto", since "required" maps to Anthropic "any", which some models refuse.
        # With auto a model may answer in prose. Plain prose becomes a pure wait (no fast retry, the mind sleeps until
        # input or its wake interval); unbalanced prose is a runtime format failure under the three-retry cap.
        from hive.runtime.extensions import hive_helpers as h
        engine = self.engine()
        self.assertEqual(engine.convert_request(self.request())['tool_choice'], 'auto')  # upstream sends 'required'
        text, kind = self.chat_with("Sure, I'll look into that for you.")
        commands, retry = self.prepared(text, kind)
        self.assertEqual(retry, 'normal')
        self.assertTrue(commands.startswith('((wait '), commands)
        self.assertEqual(h.chosen_wait_seconds(commands, retry, 0), 0)
        text, kind = self.chat_with('I think the sky is blue (mostly.')
        self.assertEqual(kind, 'format')
        commands, retry = self.prepared(text, kind)
        waits, attempts = [], 0
        for _ in range(5):
            attempts = h.next_format_retry_count(retry, attempts)
            waits.append(h.chosen_wait_seconds(commands, retry, attempts))
        self.assertEqual(waits, [2, 2, 2, 0, 0])
