#!/usr/bin/env python3
"""Regression checks for the LLM provider membrane."""

import importlib
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
