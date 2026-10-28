"""Reviewed native Tools, separate from runtime modules and default disabled.

Twenty advisory sample families. A receipt hash is an operator's
byte binding, not a signature, a truth assertion, or authority for an effect.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import tomllib

FIRST = frozenset('omegahive.tools.' + name for name in (
    'atom_recall', 'attention', 'goal_compass', 'living_intent', 'standing_values',
    'ethical_appraisal', 'belief_governance', 'self_observation', 'ensemble',
    'predictive_learning', 'scratch_plans', 'novelty', 'dream_consolidation',
    'energy', 'affect', 'skill_affordance', 'substrates', 'habitat_snapshot',
    'home_assistant', 'living_home'))
SYMBOL = re.compile(r'[A-Za-z][A-Za-z0-9_.:-]{0,127}\Z')
IDENTITY = re.compile(r'omegahive\.tools\.[a-z_]+@\d+\.\d+\.\d+\Z')
TOKEN = re.compile(r';[^\n]*|"(?:\\.|[^"\\])*"|[()]|[^\s();"]+')
FENCES = '''catch(call_with_time_limit(Seconds,
 call_with_inference_limit(Goal, Steps, Fuel)), time_limit_exceeded, Timed=true),
 (var(Results)->Results=[];true), (var(Fuel)->Fuel=unknown;true),
 (var(Timed)->Timed=false;true)'''


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('tool-path-escape-or-missing')
    return path


def equation_names(path):
    """Recompute executable heads, including equation-defined constants."""
    tokens = [m.group() for m in TOKEN.finditer(Path(path).read_text()) if not m.group().startswith(';')]
    position = 0
    def read(depth=0):
        nonlocal position
        if depth > 100: raise ValueError('source-depth')
        token = tokens[position]; position += 1
        if token != '(': return token
        value = []
        while tokens[position] != ')': value.append(read(depth + 1))
        position += 1
        return value
    names = set()
    while position < len(tokens):
        form = read()
        if isinstance(form, list) and len(form) == 3 and form[0] == '=':
            lhs = form[1]
            names.add(lhs[0] if isinstance(lhs, list) else lhs)
    return names


def clean_selection(value):
    if not isinstance(value, list) or len(value) > 20 or any(
        not isinstance(x, str) or not IDENTITY.fullmatch(x) for x in value
    ) or len(set(value)) != len(value):
        raise ValueError('options.tools must be up to twenty distinct id@version strings')
    return list(value)


def admit(schema, skill, arguments):
    """Finite JSON before encoding or native parsing. Shapes confer no authority."""
    definition = schema['skills'].get(skill)
    if definition is None: raise ValueError('skill-not-qualified')
    limits = schema['limits']; nodes = 0
    def bounds(value, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > min(limits['max_input_nodes'], 512): raise ValueError('input-node-limit')
        if depth > min(limits['max_input_depth'], 12): raise ValueError('input-depth-limit')
        if isinstance(value, list):
            for item in value: bounds(item, depth + 1)
        elif type(value) not in (str, int, float): raise ValueError('non-inert-json-value')
        elif isinstance(value, str) and len(value) > 8192: raise ValueError('input-bytes-limit')
        elif type(value) in (int, float) and not (0 <= value <= 1000000): raise ValueError('numeric-envelope')
    bounds(arguments)
    if len(json.dumps(arguments, allow_nan=False).encode()) > min(limits['max_input_bytes'], 8192):
        raise ValueError('input-bytes-limit')
    def valid(value, spec):
        if isinstance(spec, str): spec = schema['types'][spec]
        kind = spec['kind']
        if kind == 'symbol':
            return type(value) is str and bool(SYMBOL.fullmatch(value)) and value not in {
                'eval', 'import', 'call', 'py-atom', 'add-atom', 'remove-atom', 'superpose', 'collapse'}
        if kind == 'number':
            return type(value) in (int, float) and math.isfinite(value) and spec['min'] <= value <= spec['max']
        if kind == 'integer':
            return type(value) in (int, float) and math.isfinite(value) and value == int(value) and spec['min'] <= value <= spec['max']
        if kind == 'enum': return type(value) is str and value in spec['values']
        if kind == 'quoted': return type(value) is str and len(value) <= spec['max']
        if kind == 'tuple':
            return isinstance(value, list) and len(value) == len(spec['fields']) and all(valid(v, s) for v, s in zip(value, spec['fields']))
        if kind == 'union': return any(valid(value, item) for item in spec['choices'])
        if kind == 'list':
            return isinstance(value, list) and len(value) <= spec['max'] and all(valid(v, spec['item']) for v in value)
        if kind == 'construct':
            return isinstance(value, list) and len(value) == len(spec['fields']) + 1 and value[0] == spec['head'] and all(
                valid(v, s) for v, s in zip(value[1:], spec['fields']))
        raise ValueError('unknown-input-type')
    fields = definition['arguments']
    if not isinstance(arguments, list) or len(arguments) != len(fields) or not all(
        valid(value, kind) for value, kind in zip(arguments, fields)
    ): raise ValueError('typed-data-shape')


def render(value):
    if isinstance(value, list): return '(' + ' '.join(render(x) for x in value) + ')'
    if type(value) in (int, float): return repr(value)
    if type(value) is str and SYMBOL.fullmatch(value): return value
    raise ValueError('non-inert-render-input')


def render_call(schema, skill, arguments):
    """Render after admission, using field types to separate symbols from text.

    A quoted ingress string never becomes native syntax. Constructor heads and
    call heads come from the reviewed schema, not an arbitrary caller tree.
    """
    admit(schema, skill, arguments)
    def term(value, spec):
        if isinstance(spec, str): spec = schema['types'][spec]
        kind = spec['kind']
        if kind == 'quoted': return json.dumps(value, ensure_ascii=True)
        if kind == 'union':
            # Admission of a single candidate uses the same bounded validator.
            for choice in spec['choices']:
                probe = {**schema, 'skills': {'probe': {'arguments': [choice]}}}
                try: admit(probe, 'probe', [value])
                except ValueError: continue
                return term(value, choice)
            raise ValueError('unrenderable-union')
        if kind == 'construct':
            return '(' + spec['head'] + (' ' if spec['fields'] else '') + ' '.join(term(v, s) for v, s in zip(value[1:], spec['fields'])) + ')'
        if kind == 'tuple': return '(' + ' '.join(term(v, s) for v, s in zip(value, spec['fields'])) + ')'
        if kind == 'list': return '(' + ' '.join(term(v, spec['item']) for v in value) + ')'
        return render(value)
    return '(' + skill + ' ' + ' '.join(term(v, s) for v, s in zip(arguments, schema['skills'][skill]['arguments'])) + ')'


class ToolRegistry:
    """D1 module validation inside the one app admitted by Programs.

    Platform owns discovery, pins and enablement. This adapter reads only the
    admitted omega-tools package and checks its modules, not another registry.
    The pack receipt remains a client freshness checksum, not a trust anchor.
    """
    def __init__(self, core_root, programs):
        self.core_root = Path(core_root).resolve()
        self.programs = programs
        self.roots = []; self.release = None; self.modules = {}; self.receipts = {}; self.lock_files = {}

    def _refresh(self):
        self.roots = []; self.release = None; self.modules = {}; self.receipts = {}; self.lock_files = {}
        release = self.programs.pinned_release('omega-tools') if self.programs else None
        if not release: raise ValueError('omega-tools-pinned-release-unavailable')
        root = Path(release['path']).resolve()
        self.release = {key: release[key] for key in ('digest', 'version')} | {'path': str(root)}
        self.roots = [root]
        for root in self.roots:
            # Source identity excludes JSON/TOML. Bind the lock to the EXISTING
            # app pin before treating any of its data as admitted.
            lock_path = contained(root, 'release-data.lock.json')
            lock_bytes = lock_path.read_bytes()
            lock_sha = hashlib.sha256(lock_bytes).hexdigest()
            pinned_lock = release.get('files', {}).get('release-data.lock.json')
            if not isinstance(pinned_lock, str) or pinned_lock.removeprefix('sha256:') != lock_sha:
                raise ValueError('release_data_unpinned')
            lock = json.loads(lock_bytes)
            self.lock_files = lock['files']
            self.release['lock_sha256'] = lock_sha
            verified_files = {}
            for relative, sha in lock['files'].items():
                actual = digest(contained(root, relative))
                if actual != sha: raise ValueError('app-data-lock-drift')
                verified_files[relative] = actual
            receipt_bytes = self.package_bytes('evidence/all-tools-pack-check.json')
            expected = hashlib.sha256(receipt_bytes).hexdigest()
            self.release['receipt_sha256'] = expected
            data = json.loads(receipt_bytes)
            if not data.get('passed'): raise ValueError('package-check-failed')
            for relative, sha in data['files'].items():
                # The same refresh has just hashed the complete lock closure.
                # Compare the receipt to those bytes, rather than reading every
                # leaf twice more. Actual consumed reads remain verified below.
                if relative not in verified_files: raise ValueError('release-data-file-uncovered')
                if verified_files[relative] != sha: raise ValueError('reviewed-package-drift')
            self.receipts[str(root)] = expected
            module_root = (root / 'modules').resolve()
            if not module_root.is_relative_to(root): raise ValueError('tool-path-escape-or-missing')
            for folder in sorted(module_root.iterdir()):
                if not folder.is_dir(): continue
                manifest = tomllib.loads(self.package_bytes(str(folder.relative_to(root) / 'module.toml')).decode())
                key = manifest['id'] + '@' + manifest['version']
                if key in self.modules or any(m['id'] == manifest['id'] for m in self.modules.values()):
                    raise ValueError('tool-id-collision')
                spec = json.loads(self.package_bytes(str(folder.relative_to(root) / 'spec.json')))
                self.modules[key] = {**manifest, 'root': str(root), 'folder': str(folder), 'spec': spec}

    def package_file(self, relative):
        """Every package read is within the one root AND covered by its lock."""
        path = contained(self.roots[0], relative)
        expected = self.lock_files.get(relative)
        if not isinstance(expected, str): raise ValueError('release-data-file-uncovered')
        if digest(path) != expected: raise ValueError('app-data-lock-drift')
        return path

    def package_bytes(self, relative):
        path = contained(self.roots[0], relative)
        data = path.read_bytes()
        expected = self.lock_files.get(relative)
        if not isinstance(expected, str): raise ValueError('release-data-file-uncovered')
        if hashlib.sha256(data).hexdigest() != expected: raise ValueError('app-data-lock-drift')
        return data

    def select(self, options):
        self._refresh()
        selected = []; names = set(); directories = set(); skills = set()
        # Includes non-module runtime equations and constant bindings.
        for base in (self.core_root / 'src', self.core_root / 'modules'):
            for path in base.rglob('*.metta'): names |= equation_names(path)
        for path in self.core_root.glob('*.metta'): names |= equation_names(path)
        runtime_ids = set()
        for path in (self.core_root / 'modules').glob('*/module.toml'):
            manifest = tomllib.loads(path.read_text()); runtime_ids.add(manifest['id'])
            skills.update(manifest.get('provides', [])); directories.add(path.parent.name)
        for key in clean_selection(options):
            module = self.modules.get(key)
            if module is None: raise ValueError('unknown-tool-version')
            if module['id'] not in FIRST: raise ValueError('tool-admission-unqualified')
            if module['id'] in runtime_ids: raise ValueError('runtime-module-id-collision')
            if module.get('requires') != ['runtime:petta'] or module.get('default_enabled') is not False or not module.get('optional'):
                raise ValueError('unsupported-tool-dependencies-or-default')
            if module['market']['effects'] or module['spec'].get('effects') or module['spec']['effect_authority'] != 'none':
                raise ValueError('tool-effects-not-authorized')
            folder = Path(module['folder']); root = Path(module['root'])
            declared = json.loads(self.package_bytes(str(folder.relative_to(root) / 'exports.json')))
            actual = set()
            for path in folder.rglob('*.metta'):
                if path.name != 'entry.metta': actual |= equation_names(self.package_file(str(path.relative_to(root))))
            exported = {x['name'] for x in declared['callables']} | set(declared['defined_constants'])
            if actual != exported: raise ValueError('tool-export-inventory-mismatch')
            if names & actual or skills & set(module['provides']) or folder.name in directories:
                raise ValueError('tool-executable-collision')
            schema = json.loads(self.package_bytes('admission.json'))
            if not all(s['name'] in schema['skills'] and 0 < s['max_ms'] <= 2000 and 0 < s['max_steps'] <= 1000000 for s in module['spec']['skills']):
                raise ValueError('unsupported-tool-fences-or-schema')
            constructors = {x['head'] for x in declared['constructors']}
            if constructors & names: raise ValueError('tool-constructor-executable-collision')
            names |= actual; skills.update(module['provides']); directories.add(folder.name)
            selected.append(module)
        return selected

    def plan(self, options, petta_path, python=sys.executable):
        selected = self.select(options)
        return {'version': 1, 'core_root': str(self.core_root), 'roots': [str(p) for p in self.roots],
                'reviewed': dict(self.receipts), 'release': dict(self.release), 'tools': list(options), 'petta': str(Path(petta_path).resolve()),
                # Keep a venv executable's symlink path: resolving it discards
                # the venv and can silently lose Janus and its dependencies.
                'python': os.path.abspath(python),
                'skills': {skill['name']: {'module': module['id'] + '@' + module['version'], **skill}
                           for module in selected for skill in module['spec']['skills']}}

    def preflight(self, plan):
        # Configuration admission only; native qualification belongs to the
        # first sandboxed call/shadow receipt, not every options update.
        from . import sandbox_run
        # plan() has already validated every selected module and collision.
        # Recheck its exact release now, without reparsing the core equations
        # a third time for the same call. No validation crosses a request.
        clean_selection(plan['tools'])
        self.require_release(plan['release'])
        runtime = sandbox_run._runtimes().get('metta')
        # Ask the SAME runner capability check used by its run path. Mind
        # isolation does not prove Linux app-bundle support (owner r14).
        if 'omega-tools' not in sandbox_run._allowed_apps() or not sandbox_run.available():
            raise ValueError('shared-tools-sandbox-not-configured')
        if not runtime or not Path(runtime['exe']).is_file() or not Path(plan['petta']).is_dir():
            raise ValueError('shared-tools-runtime-not-configured')
        return self.verify_engine(plan['petta'])

    def verify_engine(self, petta_path):
        """Reuse the package's reviewed Foundations engine pins for every skill.

        Operator configuration selects the engine location; it cannot silently
        change the native implementation qualified by this package. Checks
        before and after a job do not claim filesystem rollback resistance.
        """
        self._refresh()
        manifest = json.loads(self.package_bytes('foundations/manifest.json'))
        for relative, expected in manifest['source_pins'].items():
            if hashlib.sha256(self.package_bytes('foundations/' + relative)).hexdigest() != expected:
                raise ValueError('foundation-source-drift')
        pins = manifest.get('engine', {}).get('source_pins')
        if not isinstance(pins, dict) or not pins: raise ValueError('reviewed-engine-pins-required')
        engine = Path(petta_path).resolve()
        for relative, expected in pins.items():
            if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
                raise ValueError('invalid-reviewed-engine-pin')
            if digest(contained(engine, relative)) != expected: raise ValueError('engine-source-drift')
        return hashlib.sha256(json.dumps(pins, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def catalogue(self):
        self._refresh()
        return [{'id': key, **module['market'], 'activatable': module['id'] in FIRST,
                 'qualification_scope': 'banked synthetic examples only; host/live qualification separate'}
                for key, module in self.modules.items()]

    def require_release(self, expected):
        self._refresh()
        if self.release != expected: raise ValueError('app-release-changed-during-use')


def refuse(reason):
    return {'kind': 'ToolAdmissionRefused', 'reason': str(reason), 'authority': 'none', 'results': []}


async def run_for_actor(ctx, params, *, foundation=False):
    """Authenticated app action -> one shared sandbox runner, never a mind child.

    The host freezes reviewed native files in a private, small app bundle before
    the shared runner rechecks it. Mind data never selects an executable, path,
    runtime, fence or actor. No standalone subprocess launcher exists here.
    """
    import asyncio
    from . import sandbox_run
    actor = getattr(ctx, 'actor', None) or {}
    command = getattr(ctx, 'command', None) or {}
    hive = ctx._hive
    if actor.get('kind') != 'mind' or actor.get('route') != 'agent' or command.get('route') != 'agent':
        return refuse('authenticated-mind-action-required')
    if command.get('action') != ('run-foundation' if foundation else 'run-native'):
        return refuse('wrong-host-action')
    if ctx._program['id'] != 'omega-tools': return refuse('wrong-app')
    ctx._need('sandbox:run')
    active = getattr(hive, '_tools_active', None)
    if active is None: hive._tools_active = active = set()
    aid = actor['id']
    if aid in active: return refuse('tool-call-in-progress')
    active.add(aid)
    try:
        agent = hive.agent(aid)
        if agent['swarm_id'] != ctx.swarm_id or actor['swarm_id'] != ctx.swarm_id:
            return refuse('actor-swarm-mismatch')
        settings = hive.settings
        if agent['kind'] not in ('omega', 'iter', 'module'):
            return refuse('unsupported-mind-kind')
        if not foundation and set(params) != {'skill', 'arguments', 'review_receipt', 'base_revision'}:
            return refuse('unexpected-run-fields')
        registry = ToolRegistry(settings.core_root, hive.programs)
        selection_before=clean_selection((agent.get('options') or {}).get('tools', []))
        selected = registry.select(selection_before)
        admitted_release = dict(registry.release)
        if (str(Path(ctx._program['path']).resolve()) != admitted_release['path'] or
                ctx._program['digest'] != admitted_release['digest']):
            return refuse('app-context-release-changed')
        if foundation:
            if set(params) != {'request', 'review_receipt', 'base_revision'} or len(registry.roots) != 1:
                return refuse('unexpected-foundation-fields-or-library')
            root = registry.roots[0]
            if params['review_receipt'] != registry.receipts[str(root)]: return refuse('stale-review-binding')
            plan = registry.plan(selection_before, settings.petta_path)
            if plan['release'] != admitted_release: return refuse('app-release-changed-before-plan')
            # preflight() runs sandbox_run.available() (a launcher subprocess, up to 10 s): off the event loop.
            engine_fingerprint = await asyncio.to_thread(registry.preflight, plan)
            import importlib.util
            spec = importlib.util.spec_from_file_location('reviewed_foundation_runner', registry.package_file('foundations/runner.py'))
            runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
            answer = await runner.execute(params['request'], shared_runner=sandbox_run, petta=settings.petta_path)
            if registry.verify_engine(plan['petta']) != engine_fingerprint:
                return refuse('engine-binding-changed-during-call')
            registry.require_release(plan['release'])
            current = hive.agent(aid)
            if current['swarm_id'] != agent['swarm_id'] or current.get('options', {}).get('tools', []) != selection_before or current['kind'] != agent['kind']:
                return refuse('selection-changed-during-call')
            answer.update(review_receipt=params['review_receipt'], recipe=params['request']['recipe'],
                          engine_source_fingerprint=engine_fingerprint, app_release_digest=plan['release']['digest'])
            return answer
        skill = params['skill']
        module = next(m for m in selected if skill in {s['name'] for s in m['spec']['skills']})
        root = Path(module['root'])
        if params['review_receipt'] != registry.receipts[str(root)]: return refuse('stale-review-binding')
        schema = json.loads(registry.package_bytes('admission.json'))
        admit(schema, skill, params['arguments'])
        ceiling = next(s for s in module['spec']['skills'] if s['name'] == skill)
        plan = registry.plan((agent.get('options') or {}).get('tools', []), settings.petta_path)
        if plan['release'] != admitted_release: return refuse('app-release-changed-before-plan')
        engine_fingerprint = await asyncio.to_thread(registry.preflight, plan)   # off the event loop (see above)
        pins = json.loads(registry.package_bytes('evidence/all-tools-pack-check.json'))['files']
        # Snapshot custody is host-side. The shared runner owns the sole process,
        # OS profile, deadline and cancellation. The mind gains no new reads.
        with tempfile.TemporaryDirectory(prefix='omega-tools-host-') as scratch:
            app = Path(scratch); bundle = app/'tools'; bundle.mkdir()
            native_root = bundle/'source'
            for source in Path(module['folder']).rglob('*.metta'):
                relative = str(source.relative_to(root)); data = registry.package_bytes(relative)
                if hashlib.sha256(data).hexdigest() != pins.get(relative): raise ValueError('snapshot-source-drift')
                target=native_root/relative; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
            # Trusted host adapter comes from the exact reviewed platform
            # candidate; package receipt separately binds each native byte.
            for name in ('tools.py','tools_worker.py'):
                (bundle/name).write_bytes(Path(__file__).with_name(name).read_bytes())
            lock = {str(p.relative_to(bundle)):digest(p) for p in bundle.rglob('*') if p.is_file()}
            (bundle/'bundle.lock.json').write_text(json.dumps({'files':lock}))
            request={'root':str(native_root),'entry':str(native_root/Path(module['folder']).relative_to(root)/module['entrypoint']),
                     'petta':str(Path(settings.petta_path).resolve()),'skill':skill,'arguments':params['arguments'],
                     'schema':schema,'seconds':ceiling['max_ms']/1000,'steps':ceiling['max_steps']}
            result = await sandbox_run.run({'id':'omega-tools','path':str(app),'capabilities':['sandbox:run']},
                                          'tools_worker.py', inputs={'request.json':json.dumps(request).encode()},
                                          outputs=['result.json'], runtime='metta', cpu_seconds=5,
                                          file_bytes=16384, timeout=7)
            if result['exit'] != 0 or result['stdout_truncated'] or result['missing_outputs'] or len(result['stderr']) >= sandbox_run.MAX_STDERR:
                return refuse('shared-evaluator-failed-or-output-incomplete')
            payload=result['outputs']['result.json']
            if len(payload)>16384: return refuse('output-bytes-limit')
            answer=json.loads(payload)
            if answer.get('authority') != 'none' or answer.get('kind') not in ('ToolResult','ToolLimitExceeded'):
                return refuse('invalid-native-result')
            if not isinstance(answer.get('results'),list) or not all(type(x) is str for x in answer['results']):
                return refuse('invalid-native-result')
            if answer['kind']=='ToolLimitExceeded' and answer['results']: return refuse('partial-limit-output')
            if registry.verify_engine(plan['petta']) != engine_fingerprint:
                return refuse('engine-binding-changed-during-call')
            registry.require_release(plan['release'])
            current=hive.agent(aid)
            if current['swarm_id'] != agent['swarm_id'] or current.get('options',{}).get('tools',[]) != selection_before or current['kind'] != agent['kind']:
                return refuse('selection-changed-during-call')
            answer.update(shared_runner=True, review_receipt=params['review_receipt'], module=module['id']+'@'+module['version'],
                          engine_source_fingerprint=engine_fingerprint, app_release_digest=plan['release']['digest'])
            return answer
    except asyncio.TimeoutError:
        return {'kind':'ToolLimitExceeded','limit':'shared-job-deadline','results':[],'authority':'none'}
    except (ValueError,KeyError,OSError,TypeError,StopIteration,RecursionError,PermissionError,RuntimeError):
        return refuse('invalid-input-package-or-shared-configuration')
    finally:
        active.discard(aid)
