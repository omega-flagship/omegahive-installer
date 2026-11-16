"""Purpose: prepare checked Singnet hooks and verify their rendered files in minds.

The recursive scheduler is read from the dependency, never from Hive source.
Every replacement must match exactly once so upstream changes fail closed.
"""
from pathlib import Path
import hashlib
import json
import tempfile
import os

ROOT = Path(__file__).resolve().parents[2]


def runtime_directory(root=ROOT):
    override = os.environ.get('OMEGACLAW_RUNTIME_CACHE')
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    identity = hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()[:16]
    return base / 'omegahive' / identity


def _replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Upstream loop changed at hook: ' + old[:90])
    return text.replace(old, new, 1)


def adapt_loop(source):
    # Keep upstream message handling, request construction, error handling,
    # tool dispatch, scheduling and recursion. Hive adds lifecycle hooks.
    source = _replace(source, '(= (collectTools)\n   (py-call (providers.getTools (getSkills))))',
                      '(= (collectTools) (py-call (hive_provider.tools)))')
    begin = source.index('(progn (initConfig)', source.index('(= (omega $k)'))
    end = source.index('(change-state! &loops (-', begin)
    # Includes the close of the true branch, but not that of the surrounding if.
    source = source[:begin] + '(hive-boot)\n                        ' + source[end:]
    source = _replace(source, '(let $prompt (getContext)', '(progn')
    source = _replace(source, '(heartbeat $k)', '(hive-cycle $k)')
    source = _replace(source, '($msg (get-state &prevmsg))',
                      '($msg (get-state &prevmsg))\n                             ($_ (change-state! &lastResponseMsgNew $msgnew))\n                             ($prompt (hive-context (input-recall $msgnew $msg) (skill-recall $msgnew $msg) (if $msgnew (HUMAN-MSG: $msg) (if (spamShield) " DO NOT RE-SEND OR SPAM!" ""))))')
    source = _replace(source, '(and (> $k 1) $msgnew)', '$msgnew')
    # Mutable energy settings must remain effective after initialization.
    head, loop = source.split('(= (omega $k)', 1)
    loop = loop.replace('(maxNewInputLoops)', '(get-state &maxNewInputLoops)')
    loop = loop.replace('(wakeupInterval)', '(get-state &wakeupInterval)')
    loop = loop.replace('(+ 1 (maxWakeLoops))', '(+ 2 (get-state &maxWakeLoops))')
    loop = loop.replace('(sleepInterval)', '(get-state &sleepInterval)')
    source = head + '(= (omega $k)' + loop
    source = _replace(source, '($response (llmProviderChat $request))',
                      '($response (py-call (hive_services.chat $request)))')
    source = _replace(source, '(if (or $msgnew  (not (== $sexpr ()))) (addToHistory $msg $sexpr $msgnew) _)',
                      '(hive-complete $msg $msgnew)')
    source = _replace(source, '(sleep (get-state &sleepInterval))',
                      '(hive-cycle-end)\n                      (sleep (get-state &sleepInterval))')
    source = _replace(source, '(if (== $k 1) (hive-boot)',
                      '(if (== (get-state &loopBootInitialized) false) (hive-boot)')
    source = _replace(source, '(log INFO "loop" (REQUEST: (py-str ($request))))',
                      '(log INFO "loop" (CHARS_SENT: (string_length $prompt)))')
    return source



def _render(root):
    """Compose directly from upstream; never overlay an embedded Hive core."""
    dependency = root / 'third_party/Omega'
    output = {}
    receipts = {}

    def render(relative):
        path = dependency / relative
        if not path.suffix:
            path = path.with_suffix('.metta')
        relative = str(path.relative_to(dependency))
        name = 'native-' + relative.replace('/', '-')
        if name in output:
            return name
        source = path.read_text()
        output[name] = ''
        text = source
        if relative == 'src/loop.metta':
            text = adapt_loop(text)
        elif relative == 'src/memory.metta':
            text = _replace(text, '(library Omega (py-str ("./memory/prompt_" $provider ".txt")))',
                            '(py-call (hive_services.memory_file (py-str ("prompt_" $provider ".txt"))))')
            text = text.replace('(library Omega ./memory/prompt.txt)', '(py-call (hive_services.memory_file "prompt.txt"))')
            text = text.replace('(library Omega ./memory/history.metta)', '(py-call (hive_services.memory_file "history.metta"))')
        elif relative == 'src/config.metta':
            text = _replace(text, '(let $value (configGetByKey $key $default)\n     (add-atom &self (= ($key) $value)))',
                            '(let $atom (sread (py-call (hive_services.config_atom $key $default)))\n     (add-atom &self $atom))')
            text = _replace(text, '(py-call (config.config_get_by_key $key $default))',
                            '(py-call (hive_services.config_value $key $default))')
        elif relative == 'src/skills.metta':
            # Web search goes through the hive (hive/core/webtools.py), never from the mind: the upstream skill keeps
            # its name and arguments and calls the hive's client (modules/web_search/src/hive_web.py).
            text = _replace(text, '(= (websearch $msg)\n   (py-call (websearch.search $msg)))',
                            '(= (websearch $msg)\n   (py-call (hive_web.search $msg)))')
            text = _replace(text, '!(add-skill websearch "Search the internet for content." (content))',
                            '!(add-skill websearch "Search the internet for content (the hive searches; same as web-search)." (content))')
        elif relative == 'profile/policy.metta':
            text = text.replace('!(import! &self (library Omega ./profile/policy.py))', '; policy Python module is loaded by bootstrap on Linux')
            text = text.replace('"./repos/Omega/profile/policy.yaml"', '(py-call (hive_services.policy_path))')
        import re
        def resolve(match):
            target = match.group(1)
            if target == './src/skills.pl':
                return '(py-call (hive_services.runtime_file "native-skills.pl"))'
            if target.endswith('.py') or target.endswith('.pl'):
                return '(library OmegaClaw-Core ./third_party/Omega/' + target.removeprefix('./') + ')'
            child = render(target.removeprefix('./'))
            return '(py-call (hive_services.runtime_file "' + child + '"))'
        text = re.sub(r'\(library Omega ([^()\s]+)\)', resolve, text)
        output[name] = text
        receipts[name] = {'upstream': relative,
                         'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
                         'runtime_sha256': hashlib.sha256(text.encode()).hexdigest()}
        return name

    # Preserve upstream library composition and its order, delaying only the
    # scheduler until Hive callback definitions are compiled.
    library = (dependency / 'lib_omega.metta').read_text()
    foundation = ['!(import! &self (library OmegaClaw-Core ./hive/runtime/hive_services.py))']
    for line in library.splitlines():
        if '(library Omega ./src/loop)' in line:
            continue
        import re
        m = re.search(r'\(library Omega ([^()\s]+)\)', line)
        if m:
            target=m.group(1).removeprefix('./')
            if target.endswith('.py'):
                # bootstrap gives Python a single, explicit upstream namespace.
                continue
            generated=render(target)
            line=line[:m.start()]+'(py-call (hive_services.runtime_file "'+generated+'"))'+line[m.end():]
        foundation.append(line)
    output['singnet-foundation.metta']='\n'.join(foundation)+'\n'
    receipts['singnet-foundation.metta'] = {
        'upstream': 'lib_omega.metta',
        'source_sha256': hashlib.sha256(library.encode()).hexdigest(),
        'runtime_sha256': hashlib.sha256(output['singnet-foundation.metta'].encode()).hexdigest(),
    }
    render('src/loop.metta')
    helper=(dependency/'src/helper.py').read_text()
    patched=_replace(helper, 'filename = "repos/Omega/memory/history.metta"',
                     'filename = os.path.join(os.environ.get("OMEGACLAW_MEMORY_DIR", str(Path.cwd() / "memory")), "history.metta")')
    output['native-helper.py']=patched
    receipts['native-helper.py']={'upstream':'src/helper.py',
        'source_sha256':hashlib.sha256(helper.encode()).hexdigest(),
        'runtime_sha256':hashlib.sha256(patched.encode()).hexdigest()}
    shell_source=(dependency/'src/skills.pl').read_text()
    shell_patched=_replace(shell_source, 'shell(Cmd, Out) :-', 'omega_shell(Cmd, Out) :-')
    shell_patched += '\n% Hive policy wrapper; execution above is the upstream implementation.\nshell(Cmd, Out) :- hive_shell(Cmd, Out).\n'
    output['native-skills.pl']=shell_patched
    receipts['native-skills.pl']={'upstream':'src/skills.pl',
        'source_sha256':hashlib.sha256(shell_source.encode()).hexdigest(),
        'runtime_sha256':hashlib.sha256(shell_patched.encode()).hexdigest()}
    output['singnet-core.json']=json.dumps(receipts,indent=2)+'\n'
    return output


def prepare(root=ROOT):
    """Verify the dependency and publish its composition from the hive or setup."""
    root=Path(root).resolve()
    from hive.runtime.core import verify_and_stamp
    verify_and_stamp(root)
    output=_render(root)
    directory=runtime_directory(root)
    directory.mkdir(parents=True, exist_ok=True)
    for name,text in output.items():
        path=directory/name
        if path.exists() and path.read_text()==text:continue
        with tempfile.NamedTemporaryFile(mode='w',dir=directory,delete=False) as handle:
            handle.write(text)
            temporary=Path(handle.name)
        temporary.chmod(0o644)
        temporary.replace(path)
    return directory/'native-src-loop.metta'


def _verified_path(name):
    """Check the hive's read-only receipt without Git or upstream rendering."""
    directory = runtime_directory(ROOT)
    filename = 'singnet-core.json'
    try:
        receipt = json.loads((directory / filename).read_text())
        if not isinstance(receipt, dict) or name not in receipt:
            raise ValueError('missing requested runtime file')
        # Time: b bytes hashed, b = total rendered file size. Space: largest file.
        for filename, row in receipt.items():
            if Path(filename).name != filename or filename in {'.', '..'}:
                raise ValueError('invalid runtime filename')
            actual = hashlib.sha256((directory / filename).read_bytes()).hexdigest()
            if actual != row['runtime_sha256']:
                raise ValueError('runtime hash differs')
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError('Run python3 scripts/setup_core.py: missing or stale Singnet composition ' + filename) from error
    return str(directory / name)


def loop_path():
    return _verified_path('native-src-loop.metta')


def foundation_path():
    return _verified_path('singnet-foundation.metta')


def bootstrap():
    """Resolve core Python names to the pinned dependency before any plugins."""
    import importlib.util
    import os
    import sys
    if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
    _verified_path('singnet-foundation.metta')
    dependency=ROOT/'third_party/Omega'
    for directory in (ROOT/'hive/runtime/extensions',ROOT,dependency,dependency/'providers',dependency/'src'):
        path=str(directory)
        if path not in sys.path:sys.path.insert(0,path)
    def load(name,path):
        existing=sys.modules.get(name)
        if existing is not None:
            if Path(existing.__file__).resolve()!=path.resolve():
                raise RuntimeError('Core namespace conflict: '+name+' from '+str(existing.__file__))
            return existing
        spec=importlib.util.spec_from_file_location(name,path)
        module=importlib.util.module_from_spec(spec)
        sys.modules[name]=module
        spec.loader.exec_module(module)
        return module
    for name in ('logger','utils','config','providers','embedding_models'):
        load(name,dependency/'src'/f'{name}.py')
    from hive.runtime.logging_privacy import protect_config_logger
    protect_config_logger()
    load('helper',runtime_directory(ROOT)/'native-helper.py')
    load('lib_llm_ext',dependency/'providers/lib_llm_ext.py')
    for name in ('plugin','channels','fileio','rag'):
        load(name,dependency/'src'/f'{name}.py')
    # web search: the hive's client, never upstream websearch.py (which searches from inside the mind)
    load('hive_web',ROOT/'modules'/'web_search'/'src'/'hive_web.py')
    if sys.platform == 'linux':
        load('policy',dependency/'profile/policy.py')
    return True


def effective_source(root=ROOT):
    root=Path(root)
    return (root/'hive/runtime/extensions/loop_hooks.metta').read_text()+'\n'+prepare(root).read_text()
