import os
import re
import openai
from typing import Optional

try:
    from src.python_runtime import configure_embedded_python_runtime
except Exception:  # pragma: no cover - direct import from src path
    try:
        from python_runtime import configure_embedded_python_runtime
    except Exception:
        configure_embedded_python_runtime = None

if configure_embedded_python_runtime is not None:
    configure_embedded_python_runtime()

try:
    import energy as _energy
except Exception:
    _energy = None


def _log_provider_call(**kwargs) -> None:
    if _energy is None:
        return
    try:
        _energy.log_provider_call(**kwargs)
    except Exception:
        return

def _incomplete_choice(choice) -> bool:
    reason = getattr(choice, "finish_reason", None)
    if reason in {"length", "max_tokens", "content_filter"}:
        # Never let parenthesis repair or the command parser admit a prefix of
        # a response which the provider explicitly says did not finish.
        print(f"[lib_llm_ext] incomplete_response finish_reason={reason}; command text discarded")
        return True
    return False

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _env_csv(name: str) -> list[str]:
    return [part.strip() for part in os.environ.get(name, "").split(",") if part.strip()]


def _env_suffix(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", str(value or "")).strip("_").upper()


class AbstractAIProvider:
    def __init__(self, name: str):
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def chat(self, model: str, content: str, max_tokens: int = 6000, **kwargs) -> str:
        raise NotImplementedError

    @property
    def is_available(self) -> bool:
        raise NotImplementedError

    @property
    def required_env(self) -> str:
        return ""


class _RuntimeFailure(str):
    """A string-compatible provider result with runtime provenance; model text never receives this type."""
    def __new__(cls, text, kind):
        value = super().__new__(cls, text)
        value.failure_kind = kind
        return value

class AIProvider(AbstractAIProvider):
    """Lazy AI provider with on-demand initialization."""

    def __init__(self, name: str, var_name: str, model_name: str, base_url: str):
        super().__init__(name)
        self._var_name = var_name
        self._model_name = model_name
        self._base_url = base_url
        self._client = None  # lazy initialization

    def _ensure_client(self):
        """Initialize client on first use."""
        if self._client is None:
            self._client = self._create_client()

    def _create_client(self) -> Optional[openai.OpenAI]:
        """Create OpenAI client from environment."""
        if self._var_name in os.environ:
            if self._var_name == "OLLAMA_API_KEY":
                llm_server_local_url = os.environ.get("LLM_SERVER_LOCAL_URL")
                if llm_server_local_url:
                    self._base_url = llm_server_local_url.rstrip("/") + "/v1"
                elif not self._base_url.endswith("/v1"):
                    self._base_url = self._base_url.rstrip("/") + "/v1"
            timeout = _env_int("OMEGACLAW_LLM_TIMEOUT_SECONDS", 120)
            max_retries = _env_int("OMEGACLAW_LLM_MAX_RETRIES", 1)
            return openai.OpenAI(
                api_key=os.environ.get(self._var_name),
                base_url=self._base_url,
                timeout=timeout,
                max_retries=max_retries,
            )

        return None

    @property
    def is_available(self) -> bool:
        """Check if provider is configured (without initializing)."""
        return bool(os.environ.get(self._var_name))

    @property
    def required_env(self) -> str:
        return self._var_name

    @property
    def model_name(self) -> str:
        return os.environ.get("LLM") or self._model_name

    def _openrouter_extra_body(self, request_kwargs):
        """Return OpenRouter routing hints supplied by runtime configuration."""
        extra_body = dict(request_kwargs.get("extra_body") or {})
        suffix = _env_suffix(self.model_name)
        order = (
            _env_csv(f"OMEGACLAW_OPENROUTER_PROVIDER_ORDER_{suffix}")
            or _env_csv("OMEGACLAW_OPENROUTER_PROVIDER_ORDER")
        )
        if order:
            allow_fallbacks = _env_bool(
                f"OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS_{suffix}",
                _env_bool("OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS", False),
            )
            extra_body.setdefault("provider", {
                "order": order,
                "allow_fallbacks": allow_fallbacks,
            })
        return extra_body

    def chat(self, content: str, max_tokens: int = 6000, **kwargs) -> str:
        """Send chat request, initializing client if needed."""
        self._ensure_client()

        if self._client is None:
            raise RuntimeError(f"{self.name} not configured (set {self._var_name})")

        content = content.replace(":-:-:-:", " ")
        try:
            request_kwargs = dict(kwargs)
            if self.name == "OpenRouter":
                request_kwargs["extra_body"] = self._openrouter_extra_body(request_kwargs)

            response = self._client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "user", "content": content}],
                max_tokens=max_tokens,
                **request_kwargs
            )

            raw_text = response.choices[0].message.content or ""
            _log_provider_call(
                provider=self.name,
                model=getattr(response, "model", self.model_name),
                kind="llm",
                usage=getattr(response, "usage", None),
                prompt_chars=len(content),
                completion_chars=len(raw_text),
            )
            if _incomplete_choice(response.choices[0]):
                return _RuntimeFailure('wait "LLM-FORMAT-ERROR incomplete response"', 'format')
            return self._clean_text(raw_text)
        except Exception as e:
            print(f"[lib_llm_ext.AIProvider.chat] Exception while communicating with LLM: {e}")
            return _RuntimeFailure('wait "LLM-PROVIDER-ERROR retry after 60 seconds"', 'provider')

    def _clean_text(self, text: str) -> str:
        """Unescape special characters and remove provider tool-call artifacts."""
        try:
            from helper_command_parser import signature_raw_batch_complete
        except ImportError:
            from src.helper_command_parser import signature_raw_batch_complete
        # This is the ORIGINAL SDK content. A literal opening quote and an encoded closing quote must never become
        # runnable through cleanup. The runtime validates the decoded batch again before canonical repair.
        if not signature_raw_batch_complete(text):
            return _RuntimeFailure('wait "LLM-FORMAT-ERROR incomplete response"', 'format')
        return (
            text.replace("</arg_value>", " ")
                .replace("</tool_call>", " ")
                .replace("<arg_value>", " ")
                .replace("<tool_call>", " ")
                .replace("_quote_", '"')
                .replace("_apostrophe_", "'")
        )


class AsiOneProvider(AIProvider):
    """Lazy AI provider with on-demand initialization."""

    def __init__(self, name: str, var_name: str, model_name: str, base_url: str):
        super().__init__(name, var_name, model_name, base_url)

    def chat(self, content: str, max_tokens: int = 6000, **kwargs) -> str:
        """Send chat request, initializing client if needed."""
        self._ensure_client()

        if self._client is None:
            raise RuntimeError(f"{self.name} not configured (set {self._var_name})")

        sysmsg, usermsg = content.split(":-:-:-:")
        try:
            response = self._client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "system", "content": sysmsg},
                          {"role": "user", "content": usermsg}],
                max_tokens=max_tokens,
                extra_body={
                    "enable_thinking": True,
                    "thinking_budget": 6000
                },
                **kwargs
            )

            raw_text = response.choices[0].message.content or ""
            _log_provider_call(
                provider=self.name,
                model=getattr(response, "model", self.model_name),
                kind="llm",
                usage=getattr(response, "usage", None),
                prompt_chars=len(content),
                completion_chars=len(raw_text),
            )
            if _incomplete_choice(response.choices[0]):
                return _RuntimeFailure('wait "LLM-FORMAT-ERROR incomplete response"', 'format')
            return self._clean_text(raw_text)
        except Exception as e:
            print(f"[lib_llm_ext.ASIOneProvider.chat] Exception while communicating with LLM: {e}")
            return _RuntimeFailure('wait "LLM-PROVIDER-ERROR retry after 60 seconds"', 'provider')

class TestProvider(AbstractAIProvider):
    """Test provider for mocking LLM output"""

    def __init__(self):
        super().__init__("Test")
        self._mock = None
        self._controller_ip = os.environ.get("TEST_SERVER_IP")

    def _llm_mock(self):
        if not self._mock:
            from Autotests.mock.llm import LlmMockAgent, LLM_MOCK_PORT
            self._mock = LlmMockAgent((self._controller_ip, LLM_MOCK_PORT))
        return self._mock

    @property
    def is_available(self) -> bool:
        return self._controller_ip is not None

    @property
    def required_env(self) -> str:
        return "TEST_SERVER_IP"

    def chat(self, content: str, max_tokens: int = 6000, **kwargs) -> str:
        return self._llm_mock().chat(content)

# Provider registry - lazy, no initialization yet
_provider_registry = {}


def _register_provider(name: str, var_name: str, model_name: str, base_url: str):
    """Register a provider configuration (no instantiation yet)."""
    _register_provider_instance(AIProvider(name, var_name, model_name, base_url))

def _register_provider_instance(provider: AbstractAIProvider):
    """Register a pre-initialized provider configuration (no instantiation yet)."""
    _provider_registry[provider.name] = provider

def _get_provider(name: str) -> Optional[AIProvider]:
    """Get or create provider instance on demand."""
    return _provider_registry.get(name)


# Register all providers (cheap - just stores config)
_register_provider(name="ASICloud", var_name="ASI_API_KEY", model_name="minimax/minimax-m2.5", base_url="https://inference.asicloud.cudos.org/v1")
_register_provider(name="Anthropic", var_name="ANTHROPIC_API_KEY", model_name="claude-opus-4-6", base_url="https://api.anthropic.com/v1/")
_register_provider(name="Ollama-local", var_name="OLLAMA_API_KEY", model_name="qwen3.5:9b", base_url="http://localhost:11434/v1")
_register_provider_instance(AsiOneProvider(name="ASIOne", var_name="ASIONE_API_KEY", model_name="asi1-ultra", base_url="https://api.asi1.ai/v1"))
_register_provider(name="OpenRouter", var_name="OPENROUTER_API_KEY", model_name="z-ai/glm-5.1", base_url="https://openrouter.ai/api/v1")
_register_provider_instance(TestProvider())
# OmegaDots Hive gateway: the hive picks the real model and injects keys.
_register_provider(name="Hive", var_name="HIVE_LLM_TOKEN", model_name=os.environ.get("HIVE_LLM_MODEL", "hive"),
                   base_url=os.environ.get("HIVE_LLM_URL", "http://127.0.0.1:8700/llm/v1"))
# At the moment the OpenAI model call is in PeTTa, just init a default config here
_register_provider(name="OpenAI", var_name="OPENAI_API_KEY", model_name="gpt-5.4", base_url="https://api.openai.com/v1")


def callProvider(provider_name: str, content: str, max_tokens: int = 6000) -> str:
    """Generic dispatcher for MeTTa."""
    provider = _get_provider(provider_name)
    if not provider:
        return _RuntimeFailure('wait "LLM-PROVIDER-UNKNOWN provider=%s; choose a configured provider and restart"' % provider_name, 'provider')
    if not provider.is_available:
        env_name = provider.required_env or "provider API key"
        return _RuntimeFailure((
            'wait "LLM-PROVIDER-NOT-AVAILABLE provider=%s missing=%s; '
            'configure the key in .env or rerun installer repair, then restart"'
            % (provider_name, env_name)
        ), 'provider')
    return provider.chat(content=content, max_tokens=max_tokens)


def callProviderCommands(provider_name: str, content: str, max_tokens: int = 6000) -> str:
    """The runtime's command envelope carries exception/finish provenance separately from untrusted model text."""
    try:
        import helper
    except ImportError:  # package import without the runtime's src path
        from src import helper
    try:
        result = callProvider(provider_name, content, max_tokens)
    except Exception:
        result = _RuntimeFailure('wait "LLM-PROVIDER-ERROR retry after 60 seconds"', 'provider')
    return helper.prepare_model_response(str(result), result.failure_kind if isinstance(result, _RuntimeFailure) else 'normal')



_embedding_model = None

def initLocalEmbedding():
    model_name="intfloat/e5-large-v2"
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer(model_name)
    return _embedding_model

def useLocalEmbedding(atom):
    global _embedding_model
    if _embedding_model is None:
        raise RuntimeError("Call initLocalEmbedding() first.")
    return _embedding_model.encode(
        atom,
        normalize_embeddings=True
    ).tolist()
