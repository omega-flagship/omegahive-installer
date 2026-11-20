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
_LAST_WAIT = None   # a hive refusal's retry_after (seconds), for the wait it causes (last_wait_seconds)
# Why the latest chat() result was a format failure, in a few plain words for the hive's view of a stopped mind
# (hive_commons.trace): '' unless _LAST_KIND is 'format'.
_LAST_CAUSE = ''


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
    """Runtime provenance of the latest chat() result: format, provider, hive or normal.

    Set only by chat() from the provider's own result objects, never parsed from model text, so a model that writes
    "LLM-FORMAT-ERROR" gets an ordinary wait, not the runtime's short, counted retry (hive_helpers.chosen_wait_seconds).
    hive: the hive itself refused the call for spending or pace, and the wait says its sentence (last_wait_seconds).
    """
    return _LAST_KIND


def last_wait_seconds():
    """How long the latest hive refusal asks the mind to wait (its retry_after), or 0 when it gave none: a number
    either way, since the loop passes it through MeTTa to hive_helpers.chosen_wait_seconds (loop_hooks.metta
    honor-chosen-wait)."""
    return _LAST_WAIT or 0


def last_failure_cause():
    """Why the latest chat() result was a runtime format failure ('' when it wasn't one): the runtime's own words,
    set beside last_response_kind, never read from model text."""
    return _LAST_CAUSE


def _failed(kind, text, wait=None, cause=''):
    global _LAST_KIND, _LAST_WAIT, _LAST_CAUSE
    from hive.runtime.hive_provider import response
    _LAST_KIND, _LAST_WAIT, _LAST_CAUSE = kind, wait, cause
    return response(text)


def _format_cause(errors, error):
    """The runtime's words for why a reply was refused: a tool call its provider couldn't take ("Unknown tool:
    'Bash'" becomes "a tool call named Bash"), a reply with no command, or what provider_features found wrong with
    it (cut off at its room, an incomplete batch, filtered). A tool's name is the one part a model chose, so only a
    short name-shaped one is repeated; the hive says these words to the person and the mind's next attempt."""
    import re
    from hive.runtime.provider_features import take_format_cause
    found = take_format_cause()
    if errors:
        named = re.search(r"Unknown tool:\s*'([A-Za-z0-9_.:-]{1,64})'", errors[0])
        return f"a tool call named {named.group(1)}" if named else "a tool call its provider couldn't read"
    if error == 'List of tool calls is empty':
        return 'no command'
    return found or 'an incomplete reply'


def chat(request):
    global _LAST_KIND, _LAST_WAIT, _LAST_CAUSE
    import providers
    from hive.runtime.provider_features import take_refusal
    _LAST_KIND, _LAST_WAIT, _LAST_CAUSE = 'normal', None, ''
    if _PROVIDER_ERROR:
        return _failed('provider', 'wait "' + _PROVIDER_ERROR + '"')
    selected = providers._llmprovider
    engine = getattr(selected, 'delegate', getattr(selected, 'engine', selected))
    if hasattr(engine, 'is_available') and not engine.is_available:
        return _failed('provider', 'wait "LLM-PROVIDER-NOT-AVAILABLE provider=' + str(getattr(engine, '_name', 'unknown')) + '"')
    take_refusal()   # nothing from an earlier call
    try:
        result = providers.llmProviderChat(request)
    except Exception:
        return _failed('provider', 'wait "LLM-PROVIDER-ERROR retry after 60 seconds"')
    refusal = take_refusal()
    if refusal is not None and (result.is_error() or not result.calls):
        # the hive refused it for spending or pace: the mind's wait says why in the hive's words, for as long as it asks
        return _failed('hive', 'wait "' + refusal[0] + '"', wait=refusal[1])
    errors = [call.error for call in result.calls if call.is_error()]
    if errors or getattr(result, 'error', None) in (
            'List of tool calls is empty', 'Incomplete provider response; no commands executed'):
        if errors or result.error == 'List of tool calls is empty':   # provider_features logs the incomplete replies
            logging.getLogger('hive_provider').info('format failure: %s', '; '.join(errors) or result.error)
        return _failed('format', 'wait "LLM-FORMAT-ERROR incomplete response"', cause=_format_cause(errors, result.error))
    if result.is_error() or not result.calls:
        # Keep the existing wait/backoff contract. Detailed provider errors
        # remain in native logs, never a fabricated successful tool action.
        return _failed('provider', 'wait "LLM-PROVIDER-ERROR retry after 60 seconds"')
    return result


def module_loader():
    """The host's module loader (OMEGACLAW_MODULE_LOADER, else modules/loader.metta), never the mind's workspace, less
    each module whose manifest requires what this mind lacks: then the mind imports a copy of that loader without those
    modules' lines, written to its memory folder at every boot, and the log names each module left out and why.

    The same resolution the command parser authorizes against (helper_command_parser.module_loader_path and
    module_selection). The parser never reads the copy, so a mind that edits it changes nothing it may call, and the
    next boot writes it again."""
    try:
        from hive.runtime.extensions.helper_command_parser import module_loader_path, module_loader_text, module_selection
    except ImportError:
        from helper_command_parser import module_loader_path, module_loader_text, module_selection
    path = module_loader_path()
    if not path.is_file():
        raise FileNotFoundError('Hive module loader missing: ' + str(path))
    _running, off = module_selection(path)
    if not off:
        return str(path)
    log = logging.getLogger('hive_modules')
    for name, missing in off.items():
        log.warning('module %s left out: %s', name, '; '.join(f'requires {entry}: {why}' for entry, why in missing))
    copy = Path(memory_file('modules-loader.metta'))
    staged = copy.with_name(copy.name + '.new')
    staged.write_text(f'; Written at boot from {path}, without {", ".join(off)}: this mind lacks what they require.\n'
                      + module_loader_text(path, off), encoding='utf-8')
    os.replace(staged, copy)
    return str(copy)


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


# A call with nothing in it, refused before it runs: on v0.33 probe3 a mind's reply ran remember "", belief-claim "" and
# pin "" before the same three with content, and remember stored an empty memory and pin answered PIN-SUCCESS, where
# belief-claim refused with a shape warning; on a v0.36 update check a mind's send "" answered success, sent nothing,
# and the mind rested still owing the person its answer. The refusal names what the skill needs, so the mind sends it
# again with content on its next turn. The skills and what each needs come from the runtime's own tables: the Effect a
# skill declares, a memory write (writes-*, ltm-entry, working-memory-state) or a message (message-sent), and the usage
# in the skill's first SkillCardLine, so a new skill is covered by its declaration.
_EXTENSIONS = Path(__file__).resolve().parent / 'extensions'
_EFFECT = re.compile(r'\(Effect "([^"]+)" "([^"]+)"\)')
_UNDONE = (('written', re.compile(r'writes-[^"]*|ltm-entry|working-memory-state')), ('sent', re.compile(r'message-sent')))
_CARD_LINE = re.compile(r'\(SkillCardLine "([^"]+)" "([^"]*)"\)')
_EMPTY_CALL = re.compile(r'^\(\s*([^\s()"]+)((?:\s+"(?:\s|\\[nrt])*")*)\s*\)$')


def _refused_when_empty():
    """{skill: (what it needs, what a call with nothing leaves undone)} for every skill the runtime's affordance files
    declare as writing memory or sending a message.

    Time: one pass over the affordance files, at import."""
    texts = [p.read_text(encoding='utf-8') for p in sorted(_EXTENSIONS.glob('skill_affordance_*.metta'))]
    usage, refused = {}, {}
    for text in texts:
        for skill, line in _CARD_LINE.findall(text):
            if skill not in usage and line.startswith(skill + ' '):
                usage[skill] = line[len(skill) + 1:].split(' - ', 1)[0].strip()
    for text in texts:
        for skill, effect in _EFFECT.findall(text):
            for undone, kind in _UNDONE:
                if kind.fullmatch(effect):
                    refused[skill] = (usage.get(skill) or 'content', undone)
    return refused


REFUSED_WHEN_EMPTY = _refused_when_empty()


def empty_call_refusal(expression):
    """What a memory write or a message with nothing in it runs as instead, or None for any other call:
    (hive-refused "<text>"), which loop_hooks.metta defines to give its text back, since the loop reduces what runs and
    PeTTa's reduce has no case for a bare string. The text holds no double quote, which PeTTa's reader can't hold."""
    match = _EMPTY_CALL.match(str(expression).strip())
    if not match or match[1] not in REFUSED_WHEN_EMPTY:
        return None
    skill, (needs, undone) = match[1], REFUSED_WHEN_EMPTY[match[1]]
    return ('(hive-refused "' + skill.upper() + '-REFUSED: nothing was ' + undone + ', since ' + skill + ' was sent '
            'nothing. Send it again with its ' + needs + ', as ' + skill + ' ' + needs + '")')


def checked_command_expr(expression):
    """The expression a mind's command runs as: its refusal if it is a memory write or a message with nothing in it,
    else command_expr's."""
    return empty_call_refusal(expression) or command_expr(expression)
