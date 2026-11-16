"""Purpose: Hive adapters to Singnet services; no alternate core implementation.

The dependency owns provider requests/retries, channel dispatch, configuration,
file I/O and vector memory. Adapters retain Hive gateway and module protocols.
"""
from pathlib import Path
import importlib
import logging
import os
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
_INITIALIZED = False
_PROVIDER_ERROR = None
_LAST_KIND = 'normal'


def initialize(arguments=()):
    global _INITIALIZED
    if _INITIALIZED:
        return True
    import config
    arguments = list(arguments)
    if not any(str(arg).startswith('config=') for arg in arguments):
        arguments.append('config=' + str(ROOT / 'hive/runtime/core-defaults.yaml'))
    from hive.runtime.logging_privacy import protect_config_logger
    protect_config_logger()
    config.init_config(arguments)
    _INITIALIZED = True
    return True


def config_value(key, default=None):
    import config
    initialize()
    key = str(key)
    # Translate the existing Hive environment into the native configuration
    # namespace. Command-line values continue to take precedence upstream.
    if key in os.environ and 'OMEGA_' + key not in os.environ:
        os.environ['OMEGA_' + key] = os.environ[key]
    value = config.config_get_by_key(key, default)
    if isinstance(value, str):
        if isinstance(default, bool):
            if value.lower() in ('true', 'false'):
                return value.lower() == 'true'
        if type(default) is int:
            return int(value)
        if type(default) is float:
            return float(value)
    return value


def memory_file(name):
    path = Path(os.environ.get('OMEGACLAW_MEMORY_DIR', ROOT / 'memory'))
    path.mkdir(parents=True, exist_ok=True)
    return str(path / str(name))


def policy_path():
    return str(ROOT / 'third_party/Omega/profile/policy.yaml')


def start_channel(name):
    import channels
    name = str(name)
    module = importlib.import_module({'hive': 'hive_channel', 'multi': 'router'}.get(name, name))

    class HiveChannel(channels.CommChannel):
        """The channel module owns auth and transport; Omega owns dispatch."""
        def receive(self):
            value = module.receive() if name == 'multi' else module.getLastMessage()
            return str(value or '')

        def send(self, message):
            return module.send_control(message) if name == 'multi' else module.send_message(message)

    channels.registerCommChannel(name, HiveChannel())
    channels.commChannelStart(name)
    return True


def start_provider(name, model):
    global _PROVIDER_ERROR
    import config
    import plugin
    import providers
    import lib_llm_ext
    name = str(name)
    _PROVIDER_ERROR = None
    config._CONFIG['model'] = str(model)
    for plugin_name in ('openaiapi', 'omega_openai', 'asione', 'openrouter', 'mockprovider'):
        plugin.loadPythonPlugin(plugin_name, str(ROOT / 'third_party/Omega/providers'))

    class Delegate(providers.LLMProvider):
        def __init__(self, engine):
            self.engine = engine
        def chat(self, request):
            return self.engine.chat(request)
        def stop(self):
            return self.engine.stop()

    providers.registerLLMProvider('Hive', Delegate(lib_llm_ext.AIProvider(
        'Hive', 'HIVE_LLM_TOKEN', os.environ.get('HIVE_LLM_MODEL', 'hive'),
        os.environ.get('HIVE_LLM_URL', 'http://127.0.0.1:8700/llm/v1'))))
    providers.registerLLMProvider('Ollama-local', Delegate(lib_llm_ext.AIProvider(
        'Ollama-local', 'OLLAMA_API_KEY', str(model),
        os.environ.get('LLM_SERVER_LOCAL_URL', 'http://localhost:11434').rstrip('/') + '/v1')))
    if name not in providers._llmProviderRegistry:
        _PROVIDER_ERROR = 'LLM-PROVIDER-UNKNOWN provider=' + name
        return False
    providers.llmProviderStart(name)
    from hive.runtime.provider_features import extend
    selected = providers._llmprovider
    attribute = 'delegate' if hasattr(selected, 'delegate') else 'engine'
    if hasattr(selected, attribute):
        setattr(selected, attribute, extend(getattr(selected, attribute)))
    return True


def last_response_kind():
    """Runtime provenance of the latest chat() result: format, provider or normal.

    Set only by chat() from the provider's own result objects, never parsed from model text, so a model that writes
    "LLM-FORMAT-ERROR" gets an ordinary wait, not the runtime's short, counted retry (hive_helpers.chosen_wait_seconds).
    """
    return _LAST_KIND


def _failed(kind, text):
    global _LAST_KIND
    from hive.runtime.hive_provider import response
    _LAST_KIND = kind
    return response(text)


def chat(request):
    global _LAST_KIND
    import providers
    _LAST_KIND = 'normal'
    if _PROVIDER_ERROR:
        return _failed('provider', 'wait "' + _PROVIDER_ERROR + '"')
    selected = providers._llmprovider
    engine = getattr(selected, 'delegate', getattr(selected, 'engine', selected))
    if hasattr(engine, 'is_available') and not engine.is_available:
        return _failed('provider', 'wait "LLM-PROVIDER-NOT-AVAILABLE provider=' + str(getattr(engine, '_name', 'unknown')) + '"')
    try:
        result = providers.llmProviderChat(request)
    except Exception:
        return _failed('provider', 'wait "LLM-PROVIDER-ERROR retry after 60 seconds"')
    errors = [call.error for call in result.calls if call.is_error()]
    if errors or getattr(result, 'error', None) in (
            'List of tool calls is empty', 'Incomplete provider response; no commands executed'):
        if errors or result.error == 'List of tool calls is empty':   # provider_features logs the incomplete replies
            logging.getLogger('hive_provider').info('format failure: %s', '; '.join(errors) or result.error)
        return _failed('format', 'wait "LLM-FORMAT-ERROR incomplete response"')
    if result.is_error() or not result.calls:
        # Keep the existing wait/backoff contract. Detailed provider errors
        # remain in native logs, never a fabricated successful tool action.
        return _failed('provider', 'wait "LLM-PROVIDER-ERROR retry after 60 seconds"')
    return result


def module_loader():
    """The host's module loader (OMEGACLAW_MODULE_LOADER, else modules/loader.metta), never the mind's workspace.

    The same resolution the command parser authorizes against (helper_command_parser.module_loader_path)."""
    try:
        from hive.runtime.extensions.helper_command_parser import module_loader_path
    except ImportError:
        from helper_command_parser import module_loader_path
    path = module_loader_path()
    if not path.is_file():
        raise FileNotFoundError('Hive module loader missing: ' + str(path))
    return str(path)


def command_expr(expression):
    """Select Hive extensions after policy has inspected the public command: a mind's own query recalls its memory
    with the hive's promotions (symbolic_memory.metta hive-memory-query), a name no module skill uses: hive-query is the
    commons skill and hive-recall the screen's, and either would shadow the recall or be shadowed by it."""
    return re.sub(r'^\((query|episodes)(?=\s)',
                  lambda match: '(' + {'query': 'hive-memory-query', 'episodes': 'hive-episodes'}[match[1]],
                  str(expression))


def config_atom(key, default):
    from hive.runtime.extensions.helper_metta import _config_value_expr, _METTA_SYMBOL_RE
    key = str(key)
    if not _METTA_SYMBOL_RE.fullmatch(key):
        raise ValueError('Invalid configuration key')
    return '(= (' + key + ') ' + _config_value_expr(config_value(key, default)) + ')'


def runtime_file(name):
    from hive.runtime.native_core import runtime_directory
    return str(runtime_directory(ROOT) / str(name))


# A memory write with nothing in it: on v0.33 probe3 a mind's reply ran remember "", belief-claim "" and pin "" before
# the same three with content. remember stored an empty memory and pin answered PIN-SUCCESS, where belief-claim refused
# with a shape warning. Every such call is refused before it runs, naming what the skill needs, so the mind sends it again
# with content on its next turn. The skills and what each needs come from the runtime's own tables: an Effect that writes
# (writes-*, ltm-entry, working-memory-state) and the usage in the skill's first SkillCardLine.
_EXTENSIONS = Path(__file__).resolve().parent / 'extensions'
_WRITING_EFFECT = re.compile(r'\(Effect "([^"]+)" "(?:writes-[^"]*|ltm-entry|working-memory-state)"\)')
_CARD_LINE = re.compile(r'\(SkillCardLine "([^"]+)" "([^"]*)"\)')
_EMPTY_CALL = re.compile(r'^\(\s*([^\s()"]+)((?:\s+"(?:\s|\\[nrt])*")*)\s*\)$')


def _memory_writes():
    """{skill: what it needs} for every memory-writing skill the runtime's affordance files declare.

    Time: one pass over the affordance files, at import."""
    texts = [p.read_text(encoding='utf-8') for p in sorted(_EXTENSIONS.glob('skill_affordance_*.metta'))]
    usage = {}
    for text in texts:
        for skill, line in _CARD_LINE.findall(text):
            if skill not in usage and line.startswith(skill + ' '):
                usage[skill] = line[len(skill) + 1:].split(' - ', 1)[0].strip()
    return {skill: usage.get(skill) or 'content' for text in texts for skill in _WRITING_EFFECT.findall(text)}


MEMORY_WRITES = _memory_writes()


def empty_write_refusal(expression):
    """What a memory-writing call with nothing to write runs as instead, or None for any other call:
    (hive-refused "<text>"), which loop_hooks.metta defines to give its text back, since the loop reduces what runs and
    PeTTa's reduce has no case for a bare string. The text holds no double quote, which PeTTa's reader can't hold."""
    match = _EMPTY_CALL.match(str(expression).strip())
    if not match or match[1] not in MEMORY_WRITES:
        return None
    skill, needs = match[1], MEMORY_WRITES[match[1]]
    return ('(hive-refused "' + skill.upper() + '-REFUSED: nothing was written, since ' + skill + ' was sent nothing. '
            'Send it again with its ' + needs + ', as ' + skill + ' ' + needs + '")')


def checked_command_expr(expression):
    """The expression a mind's command runs as: its refusal if it is a memory write with nothing in it, else
    command_expr's."""
    return empty_write_refusal(expression) or command_expr(expression)
