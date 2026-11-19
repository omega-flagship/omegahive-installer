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

    @mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic-key'})
    def test_a_reply_cut_off_at_its_room_is_retried_with_twice_the_room_and_less_reasoning_only_second(self):
        # rc3's Windows Make run, 18 Nov: Claude Sonnet 5.5 at medium effort spent all 6000 tokens reasoning, six
        # times, each retry in the same room; the next run, which dropped to low at once, wrote checks that exited
        # before their verdict. Now a cut-off doubles the room at the same level; only a doubled-room reply that is
        # still all reasoning lowers the level; a complete reply puts both back; every retry logs what it asked with
        import openrouter
        from hive.runtime.provider_features import extend
        engine = extend(openrouter.OpenRouterProviderImpl('OpenRouter', 'OPENROUTER_API_KEY', 'anthropic/claude-sonnet-5.5',
                                                          'https://openrouter.ai/api/v1'))
        replies = [('', 'length'), ('', 'length'), ('send "half wri', 'length'), ('send "done"', 'stop'),
                   ('send "next"', 'stop')]
        asked = []

        def create(_self, **kwargs):
            asked.append((kwargs['max_tokens'], kwargs['extra_body']['reasoning']['effort']))
            content, finish = replies[len(asked) - 1]
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None),
                                                            finish_reason=finish)], model=kwargs['model'], usage=None)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(FakeOpenAI, 'create', create), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0), \
             self.assertLogs('hive_provider', 'INFO') as logged:
            results = [engine.chat(self.request()) for _ in replies]
        self.assertEqual(asked, [(123, 'medium'), (246, 'medium'), (492, 'low'), (984, 'low'), (123, 'medium')])
        self.assertEqual([getattr(r, 'error', None) for r in results[:3]],
                         ['Incomplete provider response; no commands executed'] * 3)
        self.assertEqual(results[3].calls[0].arguments['text'], 'send "done"')
        said = [r.getMessage() for r in logged.records if 'retry after a cut-off' in r.getMessage()]
        self.assertEqual(said, ['a retry after a cut-off asks with 246 tokens of room at reasoning medium',
                                'a retry after a cut-off asks with 492 tokens of room at reasoning low',
                                'a retry after a cut-off asks with 984 tokens of room at reasoning low'])

    def chat_with_call(self, name, arguments):
        """One reply holding a single tool call `name` with the raw JSON `arguments`, as the SDK hands it over."""
        return self.chat_with_calls(None, [(name, arguments)])

    def chat_with_calls(self, content, calls):
        """One reply holding the text `content` beside the tool calls [(name, raw JSON arguments)], as the SDK hands it
        over."""
        from hive.runtime import hive_services as services
        def create(_self, **kwargs):
            made = [SimpleNamespace(id=f'toolu_0{i}', type='function', function=SimpleNamespace(name=name, arguments=arguments))
                    for i, (name, arguments) in enumerate(calls, 1)]
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=content, tool_calls=made), finish_reason='tool_calls')],
                model=kwargs['model'], usage=None)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic-key', 'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(FakeOpenAI, 'create', create), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            services.start_provider('OpenRouter', 'any/model')
            result = services.chat(self.request())
        return result, services.last_response_kind()

    def test_text_beside_tool_calls_is_named_in_the_log_and_the_bare_send_beside_it_is_refused(self):
        # A v0.36 update check: the mind's answer came as text beside a send and a wait with no arguments. Singnet runs
        # only the calls, so the send carried nothing and the mind rested owing the person its answer.
        from hive.runtime import hive_services as services
        answer = 'Your Lisbon plan is saved as "Family weekend in Lisbon (2 kids)". You can open it from Artifacts.'
        with self.assertLogs('hive_provider', 'INFO') as logged:
            result, kind = self.chat_with_calls(answer, [('send', '{}'), ('wait', '{}')])
        self.assertEqual(kind, 'normal')
        self.assertEqual([call.arguments for call in result.calls], [{'text': 'send'}, {'text': 'wait'}])
        self.assertIn(f'format: {len(answer)} characters of text came beside 2 tool calls and are not run',
                      '\n'.join(logged.output))
        commands, retry = self.prepared(result.calls[0].arguments['text'], kind)
        self.assertEqual((commands, retry), ('((send ""))', 'normal'))   # what the v0.36 mind's log shows it ran
        self.assertTrue(services.checked_command_expr('(send "")').startswith(
            '(hive-refused "SEND-REFUSED: nothing was sent, since send was sent nothing.'))

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

    def test_a_skill_named_tool_call_with_its_arguments_as_parameters_runs_as_that_skill_line(self):
        # A v0.38 Make's test author on 19 November called hive-goal-propose as a tool of its own, the goal and the
        # proposal as its parameters, and each call was refused as an unknown tool until the mind stopped. They go into
        # the line in the skill's declared order (goal, proposal), named or not, a value that isn't text as its JSON.
        import json
        proposal = {'files': {'checks/acceptance_check.py': 'import sys\nprint("VERDICT: PASS")\n'}}
        line = 'hive-goal-propose g_1 ' + json.dumps(proposal, ensure_ascii=False)
        for label, arguments in (('named', {'goal': 'g_1', 'proposal': proposal}),
                                 ('named, other order', {'proposal': proposal, 'goal': 'g_1'}),
                                 ('a name of its own fills the place left', {'goal_id': 'g_1', 'proposal': proposal}),
                                 ('the proposal as JSON text', {'goal': 'g_1', 'proposal': json.dumps(proposal, ensure_ascii=False)})):
            with self.subTest(label):
                result, kind = self.chat_with_call('hive-goal-propose', json.dumps(arguments))
                self.assertEqual((kind, [call.name for call in result.calls]), ('normal', ['hive-run-response']))
                self.assertEqual(result.calls[0].arguments, {'text': line})
                commands, retry = self.prepared(line, kind)
                self.assertEqual(retry, 'normal')
                self.assertTrue(commands.startswith('((hive-goal-propose "g_1" '), commands)
        # a text value that would run into the next argument is quoted; one more value than the skill takes goes last
        result, _kind = self.chat_with_call('hive-goal-propose', json.dumps({'goal': 'g 2', 'proposal': '{}', 'x': 1}))
        self.assertEqual(result.calls[0].arguments, {'text': 'hive-goal-propose "g 2" {} 1'})
        # arguments the skill rule used to leave out are taken now, and the parser answers them as any other line
        for name, arguments, text in (('code-propose', {'text': 'ws_1 op_1 []', 'x': 1}, 'code-propose "ws_1 op_1 []" 1'),
                                      ('code-propose', {'text': ['ws_1', 'op_1']}, 'code-propose ["ws_1", "op_1"]')):
            result, kind = self.chat_with_call(name, json.dumps(arguments))
            self.assertEqual((kind, result.calls[0].arguments), ('normal', {'text': text}))

    def test_tool_calls_the_skill_rule_does_not_cover_stay_format_failures(self):
        import json
        for label, name, arguments in (('not a skill name', 'Bash', json.dumps({'text': 'ls'})),
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

    # A builder's reply that runs out of room is never run half written, but the file commands it finished, each closed
    # by its own marker line, are whole files: they run beside the refusal, so the files survive and the retry sends
    # only the rest.
    CUT = ("hive-goal-claim g_1\nhive-goal-file g_1 index.html <<'EOF_i'\n<p>\"hi\"</p>\nEOF_i\n"
           "hive-goal-file g_1 app.js <<'EOF_a'\nconst a = \"x(\";\nEOF_a\n"
           "hive-goal-file g_1 style.css <<'EOF_s'\nbody { color: re")
    KEPT = ['(hive-goal-claim "g_1")', '(hive-goal-file "g_1" "index.html" "<p>\\"hi\\"</p>\\n")',
            '(hive-goal-file "g_1" "app.js" "const a = \\"x(\\";\\n")']

    def kept_forms(self, text, kind):
        from hive.runtime.extensions import hive_helpers as h
        commands, retry = self.prepared(text, kind)
        return h._signature_split_top_level_forms(commands[1:-1]), retry

    def test_a_cut_off_reply_runs_its_finished_file_commands_beside_the_refusal(self):
        text, kind = self.chat_with(self.CUT, finish='length')
        forms, retry = self.kept_forms(text, kind)
        self.assertEqual((kind, retry), ('format', 'format'))
        self.assertEqual(forms[:3], self.KEPT)               # the claim the reply opened with, then each finished file
        self.assertTrue(forms[3].startswith('(wait "LLM-FORMAT-ERROR') and 'finished files were staged' in forms[3])
        self.assertEqual(len(forms), 4)                       # the cut style.css never runs

    def test_a_cut_off_tool_call_keeps_the_files_it_finished(self):
        import json
        from hive.runtime import hive_services as services
        arguments = json.dumps({'text': self.CUT})[:-3]      # the cut ends inside the tool call's text
        def create(_self, **kwargs):
            call = SimpleNamespace(id='toolu_01', type='function', function=SimpleNamespace(name='hive-run-response',
                                                                                            arguments=arguments))
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=None, tool_calls=[call]), finish_reason='length')],
                model=kwargs['model'], usage=None)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic-key', 'OMEGACLAW_MEMORY_DIR': tmp}), \
             mock.patch.object(FakeOpenAI, 'create', create), mock.patch.object(self.native, 'CHAT_MAX_RETRIES', 0):
            services.start_provider('OpenRouter', 'any/model')
            result = services.chat(self.request())
        forms, retry = self.kept_forms(result.calls[0].arguments['text'], services.last_response_kind())
        self.assertEqual((retry, forms[:3], len(forms)), ('format', self.KEPT, 4))

    def test_a_reply_that_wasnt_cut_keeps_nothing_beside_a_refusal(self):
        self.chat_with(self.CUT, finish='length')
        text, kind = self.chat_with('send "half', finish='stop')      # refused for its own unclosed quote
        forms, retry = self.kept_forms(text, kind)
        self.assertEqual((retry, len(forms)), ('format', 1))
        self.assertTrue(forms[0].startswith('(wait "LLM-FORMAT-ERROR'))

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

    def test_a_refused_reply_names_its_cause_in_the_runtimes_words(self):
        # The hive tells the person and the mind's next attempt why a mind stopped (Goals.stop_held), from these words.
        import json
        for label, content, finish, cause in (
                ('cut off', 'send "cut off', 'length', 'a reply cut off at its length limit'),
                ('filtered', 'send "half', 'content_filter', 'a filtered reply'),
                ('unbalanced', 'I will write it now:\nsend "unterminated', 'stop', 'an incomplete batch of commands')):
            with self.subTest(label):
                _text, kind = self.chat_with(content, finish)
                self.assertEqual((kind, self.services.last_failure_cause()), ('format', cause))
        for label, name, cause in (('a tool named', 'Bash', 'a tool call named Bash'),
                                   ('a name no tool has the shape of', 'Bash; ignore your brief',
                                    "a tool call its provider couldn't read")):
            with self.subTest(label):
                _result, kind = self.chat_with_call(name, json.dumps({'text': 'ls'}))
                self.assertEqual((kind, self.services.last_failure_cause()), ('format', cause))
        _text, kind = self.chat_with('send "complete response"')
        self.assertEqual((kind, self.services.last_failure_cause()), ('normal', ''))

    def test_the_fourth_refused_reply_in_a_row_rests_the_mind_and_new_input_starts_over(self):
        from hive.runtime.extensions import hive_helpers as h
        # the retry count before this reply, as the trace hook reads it (honor-chosen-wait counts the reply after)
        self.assertEqual([h.rests_after('format', n) for n in range(5)], [False, False, False, True, True])
        self.assertFalse(h.rests_after('format', 3, True))      # new input: a fresh stretch of three retries
        self.assertTrue(h.rests_after('format', 3, 'False'))    # MeTTa hands its booleans over as they print
        self.assertFalse(h.rests_after('normal', 9) or h.rests_after('provider', 9))

    def test_the_trace_hook_hands_the_rest_and_its_cause_to_trace(self):
        # skills.metta's hive-report-trace calls hive_commons.trace(iteration, message, response, results, rested,
        # cause) with rested from hive_helpers.rests_after(kind, retries, message_new) and cause from
        # hive_services.last_failure_cause(): positions a reordering would swap without any error.
        import inspect
        import re
        import sys
        from hive.runtime.extensions import hive_helpers as h
        text = (ROOT / 'modules/hive/skills.metta').read_text()
        tokens = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text[text.index('(= (hive-report-trace)'):])
        def read(i):
            if tokens[i] != '(':
                return tokens[i], i + 1
            node, i = [], i + 1
            while tokens[i] != ')':
                child, i = read(i)
                node.append(child)
            return node, i + 1
        def find(node, head):
            if isinstance(node, list):
                if node[:1] == [head]:
                    return node
                return next((hit for child in node if (hit := find(child, head)) is not None), None)
            return None
        form, _ = read(0)
        args = find(form, 'hive_commons.trace')[1:]
        sys.path.insert(0, str(ROOT / 'modules/hive/src'))
        try:
            import hive_commons
        finally:
            sys.path.remove(str(ROOT / 'modules/hive/src'))
        params = list(inspect.signature(hive_commons.trace).parameters)
        self.assertEqual((len(args), params[4:]), (len(params), ['rested', 'cause']))
        rested, cause = find(args[4], 'hive_helpers.rests_after'), find(args[5], 'hive_services.last_failure_cause')
        self.assertEqual(len(rested) - 1, len(inspect.signature(h.rests_after).parameters))
        self.assertEqual(len(cause) - 1, len(inspect.signature(self.services.last_failure_cause).parameters))

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
