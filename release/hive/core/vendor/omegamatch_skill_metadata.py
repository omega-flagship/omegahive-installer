"""Literal metadata reader candidate. No MeTTa import, evaluation or skill invocation."""
import hashlib
import json
import re

TOKENS = re.compile(r'\s+|;[^\n]*|"(?:\\.|[^"\\])*"|[()]|[^\s();]+')


def _forms(text):
    if not isinstance(text, str) or len(text.encode()) > 1024 * 1024:
        raise ValueError('metadata input too large')
    stack, roots = [], []
    for match in TOKENS.finditer(text):
        token = match.group()
        if token.isspace() or token.startswith(';'):
            continue
        if token == '(':
            if len(stack) >= 128: raise ValueError('metadata nesting too deep')
            stack.append([])
        elif token == ')':
            if not stack: raise ValueError('unbalanced metadata')
            node = stack.pop()
            (stack[-1] if stack else roots).append(node)
        else:
            if token.startswith('"'):
                try: value = json.loads(token, strict=False)
                except ValueError as exc: raise ValueError('invalid literal') from exc
            else: value = token
            (stack[-1] if stack else roots).append(value)
    if stack: raise ValueError('unbalanced metadata')
    return roots


def declarations(text):
    result = []
    for node in _forms(text):
        if not isinstance(node, list): continue
        # Recognize only the existing literal registry wrapper. Never execute it.
        if len(node) == 3 and node[:2] == ['add-atom', '&skills']:
            node = node[2]
        if isinstance(node, list) and node and node[0] in {'Skill', 'SkillTopic', 'SkillArg', 'Risk', 'Effect', 'SkillCardLine', 'SkillHelp'}:
            if any(not isinstance(x, str) or x.startswith('$') for x in node):
                continue
            result.append(node)
    return result


def project_skill_metadata(text, source_ref):
    if not isinstance(source_ref, str) or not source_ref:
        raise ValueError('source reference required')
    rows = declarations(text)
    names = sorted({r[1] for r in rows if len(r) == 2 and r[0] == 'Skill'})
    digest = 'sha256:' + hashlib.sha256(text.encode()).hexdigest()
    offers = []
    for name in names:
        selected = [r for r in rows if len(r) >= 3 and r[1] == name]
        topics = sorted({r[2] for r in selected if r[0] == 'SkillTopic' and len(r) == 3})
        args = [r[2:] for r in selected if r[0] == 'SkillArg' and len(r) == 5]
        offers.append({'name': name, 'source_ref': source_ref, 'source_digest': digest,
                       'arguments': sorted(args), 'topics': topics,
                       'risks': sorted({r[2] for r in selected if r[0] == 'Risk' and len(r) == 3}),
                       'effects': sorted({r[2] for r in selected if r[0] == 'Effect' and len(r) == 3}),
                       'cards': sorted({r[2] for r in selected if r[0] == 'SkillCardLine' and len(r) == 3}),
                       'topic_help': [r[1:] for r in rows if len(r) == 3 and r[0] == 'SkillHelp' and r[1] in topics],
                       'tier': 'advertised', 'unknowns': ['runtime-loaded', 'provider-binding', 'policy-eligibility',
                                                         'signature-completeness', 'performance']})
    return {'offers': offers, 'source_digest': digest, 'coverage': 'literal-card-subset'}



def project_module_metadata(module_id, sources):
    """Join only a host-selected module source set; do not discover/import files.

    Rule heads give syntactic call shapes, never inferred types or body behavior.
    Provides establishes declaration provenance, never live provider binding.
    """
    if not isinstance(module_id, str) or not module_id or not isinstance(sources, list) or not 1 <= len(sources) <= 64:
        raise ValueError('invalid module source set')
    refs, forms, texts = {}, [], []
    total = 0
    for source in sources:
        ref, text = source['ref'], source['text']
        if not isinstance(ref, str) or not ref or ref in refs or not isinstance(text, str):
            raise ValueError('invalid module source')
        total += len(text.encode())
        if total > 8 * 1024 * 1024: raise ValueError('module source set too large')
        refs[ref] = 'sha256:' + hashlib.sha256(text.encode()).hexdigest()
        forms.extend(_forms(text))
        texts.append(text)
    # Keep source boundaries separate when parsing; malformed files cannot repair each other.
    rows = [row for text in texts for row in declarations(text)]
    provided = set()
    signatures = {}
    typed_signatures = {}
    for form in forms:
        if (isinstance(form, list) and len(form) == 3 and form[:2] == ['Provides', module_id]
                and isinstance(form[2], list) and len(form[2]) == 2 and form[2][0] == 'Skill'
                and isinstance(form[2][1], str) and not form[2][1].startswith('$')):
            provided.add(form[2][1])
        if (isinstance(form, list) and len(form) == 3 and form[0] == ':'
                and isinstance(form[1], str) and not form[1].startswith('$')):
            typed_signatures.setdefault(form[1], []).append(form[2])
        if (isinstance(form, list) and len(form) == 3 and form[0] == '='
                and isinstance(form[1], list) and form[1] and isinstance(form[1][0], str)
                and not form[1][0].startswith('$')):
            signatures.setdefault(form[1][0], []).append(form[1][1:])
    names = sorted(provided | {r[1] for r in rows if len(r) == 2 and r[0] == 'Skill'})
    offers = []
    for name in names:
        selected = [r for r in rows if len(r) >= 3 and r[1] == name]
        topics = sorted({r[2] for r in selected if len(r) == 3 and r[0] == 'SkillTopic'})
        shapes = sorted({json.dumps(x, sort_keys=True) for x in signatures.get(name, [])})
        types = sorted({json.dumps(x, sort_keys=True) for x in typed_signatures.get(name, [])})
        offers.append({'name': name, 'module_id': module_id,
                       'provides_declared': name in provided,
                       'rule_head_shapes': [json.loads(x) for x in shapes],
                       'signature_basis': 'source-declarations-not-runtime-validation',
                       'typed_signature_declarations': [json.loads(x) for x in types],
                       'signature_conflict_unresolved': len(types) > 1,
                       'skill_help': sorted({r[2] for r in rows if len(r) == 3 and r[0] == 'SkillHelp' and r[1] == name}),
                       'arguments': sorted([r[2:] for r in selected if len(r) == 5 and r[0] == 'SkillArg']),
                       'topics': topics,
                       'risks': sorted({r[2] for r in selected if len(r) == 3 and r[0] == 'Risk'}),
                       'effects': sorted({r[2] for r in selected if len(r) == 3 and r[0] == 'Effect'}),
                       'cards': sorted({r[2] for r in selected if len(r) == 3 and r[0] == 'SkillCardLine'}),
                       'topic_help': sorted([r[1:] for r in rows if len(r) == 3 and r[0] == 'SkillHelp' and r[1] in topics]),
                       'source_refs': dict(sorted(refs.items())), 'tier': 'advertised',
                       'unknowns': ['runtime-loaded', 'provider-binding', 'requester-visibility',
                                    'policy-eligibility', 'signature-completeness', 'performance']})
    snapshot = {'module_id': module_id, 'sources': dict(sorted(refs.items())), 'offers': offers,
                'coverage': 'host-selected-source-declarations'}
    digest = 'sha256:' + hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    return dict(snapshot, digest=digest)


def project_loader_selection(text, source_ref, library='OmegaClaw-Core'):
    """Describe literal configured imports in order; no imports or path resolution.

    Host must supply the actual selected loader, not assume the repository default.
    Dynamic/unsupported imports remain gaps, so this cannot attest loaded modules.
    """
    from pathlib import PurePosixPath
    if not isinstance(source_ref, str) or not source_ref:
        raise ValueError('loader source reference required')
    imports, gaps = [], 0
    for form in _forms(text):
        if not isinstance(form, list) or not form or form[0] != 'import!':
            continue
        if (len(form) != 3 or form[1] != '&self' or not isinstance(form[2], list)
                or len(form[2]) != 3 or form[2][:2] != ['library', library]):
            gaps += 1
            continue
        path = form[2][2]
        if not isinstance(path, str) or '\\' in path or '\x00' in path or path.startswith('$'):
            gaps += 1
            continue
        logical = PurePosixPath(path)
        if logical.is_absolute() or '..' in logical.parts or not path or path in {'.', './'}:
            gaps += 1
            continue
        imports.append({'library': library, 'logical_path': str(logical), 'basis': 'configured-literal-import'})
    return {'source_ref': source_ref, 'source_digest': 'sha256:' + hashlib.sha256(text.encode()).hexdigest(),
            'imports': imports, 'unsupported_imports': gaps,
            'coverage': 'literal-loader-subset',
            'unknowns': ['actual-runtime-loader-selection', 'import-success', 'runtime-loaded', 'source-resolution',
                         'provider-binding', 'policy-eligibility']}
