#!/usr/bin/env python3
"""Regression checks for the LLM provider membrane."""

import importlib
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))


class FakeCompletions:
    def __init__(self):
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        message = SimpleNamespace(content='send "ok"')
        choice = SimpleNamespace(message=message)
        return SimpleNamespace(
            choices=[choice],
            model=kwargs.get("model"),
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )


class FakeOpenAI:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.completions = FakeCompletions()
        self.chat = SimpleNamespace(completions=self.completions)
        self.__class__.instances.append(self)


class LlmProviderTests(unittest.TestCase):
    def test_original_and_decoded_batches_are_checked_through_the_consumed_sdk_boundary(self):
        import helper
        cases = [
            'send "VALID_PREFIX"\nread-file "unterminated_quote_',
            'send _quote_VALID_PREFIX_quote_\nread-file _quote_unterminated',
            'send "VALID_PREFIX_quote_"',
        ]
        for provider_name, key in (("OpenRouter", "OPENROUTER_API_KEY"), ("ASIOne", "ASIONE_API_KEY")):
            for source in cases:
                with self.subTest(provider=provider_name, source=source), tempfile.TemporaryDirectory() as tmp:
                    with mock.patch.dict('os.environ', {key: 'invented-test-key', 'OMEGACLAW_MEMORY_DIR': tmp}):
                        module = self.load_module()
                        response = SimpleNamespace(model='invented-model', usage=None, choices=[SimpleNamespace(
                            finish_reason='stop', message=SimpleNamespace(content=source))])
                        with mock.patch.object(FakeCompletions, 'create', return_value=response) as created:
                            envelope = module.callProviderCommands(provider_name, 'invented system:-:-:-:invented input', 123)
                        created.assert_called_once()
                        self.assertEqual(helper.prepared_response_kind(envelope), 'format')
                        commands = helper.prepared_response_commands(envelope)
                        self.assertTrue(commands.startswith('((wait "LLM-FORMAT-ERROR'), commands)
                        self.assertNotIn('VALID_PREFIX', commands)

    def test_transport_failure_keeps_provider_backoff_through_the_consumed_sdk_boundary(self):
        import helper
        for provider_name, key in (("OpenRouter", "OPENROUTER_API_KEY"), ("ASIOne", "ASIONE_API_KEY")):
            with self.subTest(provider=provider_name), tempfile.TemporaryDirectory() as tmp:
                with mock.patch.dict('os.environ', {key: 'invented-test-key', 'OMEGACLAW_MEMORY_DIR': tmp}):
                    module = self.load_module()
                    with mock.patch.object(FakeCompletions, 'create', side_effect=RuntimeError('invented transport outage')) as created:
                        envelope = module.callProviderCommands(provider_name, 'invented system:-:-:-:invented input', 123)
                    created.assert_called_once()
                    self.assertEqual(helper.prepared_response_kind(envelope), 'provider')
                    self.assertEqual(helper.chosen_wait_seconds(helper.prepared_response_commands(envelope), 'provider', 1), 60)

    def test_provider_results_keep_trusted_failure_provenance_separate_from_model_text(self):
        import helper
        for provider_name, key in (("OpenRouter", "OPENROUTER_API_KEY"), ("ASIOne", "ASIONE_API_KEY")):
            for kind in ("complete", "incomplete", "empty", "malformed", "transport", "model-marker"):
                with self.subTest(provider=provider_name, kind=kind), tempfile.TemporaryDirectory() as tmp:
                    with mock.patch.dict('os.environ', {key: 'invented-test-key', 'OMEGACLAW_MEMORY_DIR': tmp}):
                        module = self.load_module()
                        text = 'send "valid prefix"\nread-file'
                        if kind == 'empty': text = ''
                        if kind == 'complete': text = 'send "complete response"'
                        if kind == 'model-marker': text = 'wait "LLM-FORMAT-ERROR invented model text"'
                        response = SimpleNamespace(model='invented-model', usage=None, choices=[SimpleNamespace(
                            finish_reason='length' if kind == 'incomplete' else 'stop', message=SimpleNamespace(content=text))])
                        behavior = {'side_effect': RuntimeError('invented transport outage')} if kind == 'transport' else {'return_value': response}
                        with mock.patch.object(FakeCompletions, 'create', **behavior) as created:
                            answer = module.callProvider(provider_name, 'invented system:-:-:-:invented input', 123)
                        created.assert_called_once()  # prove this exact mocked SDK boundary was consumed
                        if kind in ('incomplete', 'empty'):
                            self.assertEqual(answer, 'wait "LLM-FORMAT-ERROR incomplete response"')
                            self.assertEqual(answer.failure_kind, 'format')
                        elif kind == 'transport':
                            self.assertEqual(answer, 'wait "LLM-PROVIDER-ERROR retry after 60 seconds"')
                            self.assertEqual(answer.failure_kind, 'provider')
                        else:
                            self.assertEqual(answer, text)
                            self.assertIs(type(answer), str)  # model-authored marker text has NO trusted failure tag
                        prepared = helper.prepare_model_response(str(answer), getattr(answer, 'failure_kind', 'normal'))
                        self.assertEqual(set(json.loads(prepared)), {'commands', 'retry_kind'})
                        retry_kind = helper.prepared_response_kind(prepared)
                        commands = helper.prepared_response_commands(prepared)
                        expected_kind = 'provider' if kind == 'transport' else 'format' if kind in ('incomplete', 'empty', 'malformed') else 'normal'
                        self.assertEqual(retry_kind, expected_kind)
                        expected_wait = 60 if kind == 'transport' else 2 if expected_kind == 'format' else 0 if kind == 'model-marker' else -1
                        self.assertEqual(helper.chosen_wait_seconds(commands, retry_kind, 1), expected_wait)
                        if expected_kind == 'format':
                            self.assertTrue(commands.startswith('((wait "LLM-FORMAT-ERROR'), commands)
                            self.assertNotIn('valid prefix', commands)

    def load_module(self):
        sys.modules.pop("lib_llm_ext", None)
        sys.modules.pop("energy", None)
        FakeOpenAI.instances.clear()
        fake_openai_module = SimpleNamespace(OpenAI=FakeOpenAI)
        with mock.patch.dict(sys.modules, {"openai": fake_openai_module}):
            return importlib.import_module("lib_llm_ext")

    @mock.patch.dict(
        "os.environ",
        {
            "OPENROUTER_API_KEY": "test-key",
            "OMEGACLAW_LLM_TIMEOUT_SECONDS": "7",
            "OMEGACLAW_LLM_MAX_RETRIES": "0",
        },
        clear=False,
    )
    def test_provider_client_uses_bounded_timeout_and_retries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.dict("os.environ", {"OMEGACLAW_MEMORY_DIR": tmpdir}, clear=False):
                module = self.load_module()

                result = module.callProvider("OpenRouter", "hello", 123)

                self.assertEqual(result, 'send "ok"')
                self.assertEqual(len(FakeOpenAI.instances), 1)
                client = FakeOpenAI.instances[0]
                self.assertEqual(client.kwargs["timeout"], 7)
                self.assertEqual(client.kwargs["max_retries"], 0)
                self.assertEqual(client.kwargs["base_url"], "https://openrouter.ai/api/v1")
                create_kwargs = client.completions.last_kwargs
                self.assertEqual(
                    create_kwargs["model"],
                    "z-ai/glm-5.1",
                )
                self.assertEqual(create_kwargs["max_tokens"], 123)
                self.assertEqual(create_kwargs["extra_body"], {})
                self.assertTrue((pathlib.Path(tmpdir) / "cost_ledger.jsonl").exists())

    @mock.patch.dict(
        "os.environ",
        {
            "OLLAMA_API_KEY": "ollama-local",
            "LLM_SERVER_LOCAL_URL": "http://127.0.0.1:19512",
            "LLM": "e2e-model",
        },
        clear=False,
    )
    def test_provider_uses_installed_model_and_local_ollama_url(self):
        module = self.load_module()

        result = module.callProvider("Ollama-local", "hello", 123)

        self.assertEqual(result, 'send "ok"')
        self.assertEqual(len(FakeOpenAI.instances), 1)
        client = FakeOpenAI.instances[0]
        self.assertEqual(client.kwargs["base_url"], "http://127.0.0.1:19512/v1")
        create_kwargs = client.completions.last_kwargs
        self.assertEqual(create_kwargs["model"], "e2e-model")
        self.assertEqual(create_kwargs["max_tokens"], 123)

    @mock.patch.dict(
        "os.environ",
        {"OMEGACLAW_OPENROUTER_PROVIDER_ORDER": "friendli, parasail"},
        clear=False,
    )
    def test_openrouter_uses_configured_provider_order(self):
        module = self.load_module()
        provider = module.AIProvider(
            "OpenRouter",
            "OPENROUTER_API_KEY",
            "any/model",
            "https://openrouter.ai/api/v1",
        )

        extra_body = provider._openrouter_extra_body({})

        self.assertEqual(
            extra_body["provider"],
            {"order": ["friendli", "parasail"], "allow_fallbacks": False},
        )

    @mock.patch.dict(
        "os.environ",
        {
            "OMEGACLAW_OPENROUTER_PROVIDER_ORDER": "friendli",
            "OMEGACLAW_OPENROUTER_PROVIDER_ORDER_DEEPSEEK_DEEPSEEK_V4_FLASH": "parasail",
            "OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS_DEEPSEEK_DEEPSEEK_V4_FLASH": "true",
        },
        clear=False,
    )
    def test_openrouter_model_specific_provider_order_overrides_global(self):
        module = self.load_module()
        provider = module.AIProvider(
            "OpenRouter",
            "OPENROUTER_API_KEY",
            "deepseek/deepseek-v4-flash",
            "https://openrouter.ai/api/v1",
        )

        extra_body = provider._openrouter_extra_body({})

        self.assertEqual(
            extra_body["provider"],
            {"order": ["parasail"], "allow_fallbacks": True},
        )

    def test_openrouter_has_no_hardcoded_model_routing(self):
        module = self.load_module()
        provider = module.AIProvider(
            "OpenRouter",
            "OPENROUTER_API_KEY",
            "qwen/qwen3.6-35b-a3b",
            "https://openrouter.ai/api/v1",
        )

        extra_body = provider._openrouter_extra_body({})

        self.assertEqual(extra_body, {})

    @mock.patch.dict("os.environ", {}, clear=True)
    def test_unavailable_provider_returns_parseable_wait_instead_of_throwing(self):
        module = self.load_module()

        result = module.callProvider("OpenRouter", "hello", 123)

        self.assertIn('wait "LLM-PROVIDER-NOT-AVAILABLE provider=OpenRouter', result)
        self.assertIn("missing=OPENROUTER_API_KEY", result)

    def test_unknown_provider_returns_parseable_wait_instead_of_throwing(self):
        module = self.load_module()

        result = module.callProvider("NoSuchProvider", "hello", 123)

        self.assertIn('wait "LLM-PROVIDER-UNKNOWN provider=NoSuchProvider', result)


if __name__ == "__main__":
    unittest.main()
