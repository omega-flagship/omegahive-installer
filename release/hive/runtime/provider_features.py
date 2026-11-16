"""Hive provider extensions. HTTP, retries and tool parsing stay in Singnet."""
import logging
import os
import re

try:
    from src import energy as _energy
except ImportError:
    _energy = None

# One logger for the provider path's decisions (hive_services logs its format failures here too), in the mind's log.
log = logging.getLogger('hive_provider')

# The transport tool's text holds skill lines: "code-propose ws_1 op_1 [...]". A model that reads its SKILLS as tools
# sometimes calls the skill itself: tool "code-propose" with text "ws_1 op_1 [...]" (Claude Sonnet 5.5 through Google
# Vertex, replaying the Code helper's proposal turn on 12 November). Singnet's _validate_response refuses that as an
# unknown tool, so the mind lost the turn, its last results and, on a $0.25 helper, the budget to propose again.
# The name and the text (none for a skill without arguments) are that one skill line, so the call is taken as the
# transport call carrying it; the line then meets the hive's parser and per-command authorization like any other,
# an unknown skill included.
_SKILL_NAME = re.compile(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*')


def _log_provider_call(**kwargs):
    if _energy is not None:
        try:
            _energy.log_provider_call(**kwargs)
        except Exception:
            pass  # Optional accounting must not lose a completed model reply.


# A provider/model that cannot take tools answers the tool request with HTTP 400 and one of these texts (Ollama:
# "<model> does not support tools"; OpenAI-compatible servers word it variously). The SDK error text carries both.
_TOOLS_UNSUPPORTED = re.compile(r'does not support tools|tools? (?:are|is) not supported|tool use is not supported|'
                                r'does not support (?:function|tool) calling|tool_choice is not supported', re.I)


def tools_unsupported(error):
    """True for a provider error that says this model cannot take tools (a 400), never for other failures."""
    text = str(error or '')
    return bool(re.search(r'\b400\b', text)) and bool(_TOOLS_UNSUPPORTED.search(text))


class HiveProviderFeatures:
    # Set once a model refused tools (tools_unsupported): later requests are plain text, as before the native core.
    # The reply text then goes through the same raw-batch check and hive-run-response as any text reply.
    _hive_text_only = False

    def chat(self, request):
        result = super().chat(request)
        if not self._hive_text_only and getattr(request, 'tools', None) and tools_unsupported(getattr(result, 'error', None)):
            self._hive_text_only = True
            result = super().chat(request)
        return result

    def convert_request(self, request):
        self._hive_prompt_chars = sum(len(str(m.content or '')) for m in request.messages)
        result = super().convert_request(request)
        if self._hive_text_only:
            result.pop('tools', None)
            result.pop('tool_choice', None)
        if 'tool_choice' in result:
            result['tool_choice'] = 'auto'  # 'required' maps to Anthropic 'any', rejected by some models
        if self._name == 'OpenRouter':
            suffix = re.sub(r'[^A-Z0-9]+', '_', self._model_name.upper()).strip('_')
            order = os.environ.get('OMEGACLAW_OPENROUTER_PROVIDER_ORDER_' + suffix) or os.environ.get('OMEGACLAW_OPENROUTER_PROVIDER_ORDER', '')
            if order:
                fallbacks = os.environ.get('OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS_' + suffix,
                            os.environ.get('OMEGACLAW_OPENROUTER_ALLOW_FALLBACKS', 'false'))
                result.setdefault('extra_body', {})['provider'] = {
                    'order': [part.strip() for part in order.split(',') if part.strip()],
                    'allow_fallbacks': fallbacks.lower() in ('1', 'true', 'yes', 'on')}
        return result

    def convert_response(self, raw):
        import providers
        from hive.runtime.hive_provider import response, tools
        choices = getattr(raw, 'choices', None)
        text = ''
        if choices:
            choice = choices[0]
            text = getattr(choice.message, 'content', None) or ''
            if getattr(choice, 'finish_reason', None) in ('length', 'max_tokens', 'content_filter'):
                log.info('format failure: the reply ended with finish_reason %s', choice.finish_reason)
                return providers.LLMResponse().with_error('Incomplete provider response; no commands executed')
        _log_provider_call(provider=self._name, model=getattr(raw, 'model', self._model_name),
                           kind='llm', usage=getattr(raw, 'usage', None),
                           prompt_chars=getattr(self, '_hive_prompt_chars', 0), completion_chars=len(text))
        if choices and text and not getattr(choices[0].message, 'tool_calls', None):
            from hive.runtime.extensions.helper_command_parser import signature_raw_batch_complete
            # The ORIGINAL SDK content: a literal opening quote and an encoded closing quote must never become
            # runnable through cleanup. hive-run-response validates the decoded batch again before repair.
            if not signature_raw_batch_complete(text):
                log.info('format failure: a %d-character text reply is not a complete batch: %r', len(text), text[:200])
                return providers.LLMResponse().with_error('Incomplete provider response; no commands executed')
            return response(text)
        result = super().convert_response(raw)
        transport = tools()[0].name
        for call in result.calls:
            arguments = call.arguments if isinstance(call.arguments, dict) else {}
            if (call.name != transport and not call.is_error() and _SKILL_NAME.fullmatch(str(call.name or ''))
                    and set(arguments) <= {'text'} and isinstance(arguments.get('text', ''), str)):
                log.info('a tool call named %s is taken as %s carrying that skill line', call.name, transport)
                line = f"{call.name} {arguments.get('text', '').strip()}".rstrip()
                call.with_arguments({'text': line}).with_name(transport)
        return result


def extend(engine):
    """Construct a subclass using the upstream provider's own implementation."""
    import lib_llm_ext
    if not isinstance(engine, lib_llm_ext.AIProvider):
        return engine  # Native mock providers need no HTTP/accounting adapter.
    class HiveProvider(HiveProviderFeatures, type(engine)):
        pass
    return HiveProvider(engine._name, engine._var_name, engine._model_name, engine._base_url)
