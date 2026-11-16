"""Typed relational IR v1. All imported values are data, never predicates/code."""
import hashlib
import json
import math

KINDS = {'node', 'relation', 'transition', 'constraint', 'event', 'subflow'}
META = {'origin', 'confidence', 'evidence', 'revision_state', 'runtime_state'}
FIELDS = {
    'node': {'type', 'ref'}, 'relation': {'type', 'roles'},
    'transition': {'from', 'to', 'trigger', 'guards', 'action', 'approver'},
    'constraint': {'predicate', 'members'}, 'event': {'type'},
    'subflow': {'flow_id', 'revision_digest'},
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('nonempty bounded text required')


def _data(value, depth=0):
    if depth > 20: raise ValueError('data nesting limit')
    if value is None or type(value) in (bool, int, str): return
    if type(value) is float and math.isfinite(value): return
    if isinstance(value, list):
        for item in value: _data(item, depth + 1)
        return
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        for item in value.values(): _data(item, depth + 1)
        return
    raise ValueError('finite JSON data required')


def validate(flow):
    _data(flow)
    if not isinstance(flow, dict) or set(flow) != {'schema', 'id', 'entry', 'elements'} or flow['schema'] != 'omegaflow/1':
        raise ValueError('invalid flow header')
    text(flow['id']); text(flow['entry'])
    elements = flow['elements']
    if not isinstance(elements, list) or not 1 <= len(elements) <= 1000:
        raise ValueError('1..1000 elements required')
    if len(canonical(flow).encode()) > 262144: raise ValueError('flow exceeds byte limit')
    ids = {}
    for e in elements:
        if not isinstance(e, dict) or not isinstance(e.get('kind'), str) or e.get('kind') not in KINDS: raise ValueError('unknown element kind')
        kind = e['kind']
        if set(e) != {'id', 'kind', 'props', 'meta'} | FIELDS[kind]: raise ValueError('invalid element fields')
        text(e['id'])
        if e['id'] in ids: raise ValueError('duplicate element id')
        ids[e['id']] = e
        if not isinstance(e['props'], dict): raise ValueError('properties must be an object')
        m = e['meta']
        if not isinstance(m, dict) or set(m) != META: raise ValueError('invalid metadata')
        if not isinstance(m['origin'], str) or m['origin'] not in {'asserted', 'host-record', 'inferred'}: raise ValueError('invalid origin')
        c = m['confidence']
        if c is not None and (type(c) not in (int, float) or not 0 <= c <= 1): raise ValueError('invalid confidence')
        if not isinstance(m['evidence'], list): raise ValueError('invalid evidence')
        for ev in m['evidence']: text(ev)
        if not isinstance(m['revision_state'], str) or m['revision_state'] not in {'draft', 'proposed', 'adopted', 'superseded'}: raise ValueError('invalid revision state')
        if not isinstance(m['runtime_state'], str) or m['runtime_state'] not in {'idle', 'pending', 'running', 'waiting-approval', 'done', 'failed', 'cancelled'}: raise ValueError('invalid runtime state')
        if kind in {'node', 'relation', 'event'}: text(e['type'])
        if kind == 'node' and e['ref'] is not None: text(e['ref'])
        if kind == 'relation':
            if not isinstance(e['roles'], list) or not e['roles']: raise ValueError('roles required')
            for role in e['roles']:
                if not isinstance(role, dict) or set(role) != {'name', 'member'}: raise ValueError('invalid role')
                text(role['name']); text(role['member'])
        if kind == 'transition':
            for key in ('from', 'to', 'trigger'): text(e[key])
            if not isinstance(e['guards'], list): raise ValueError('invalid guards')
            for guard in e['guards']: text(guard)
            a = e['action']
            if not isinstance(a, dict) or set(a) != {'kind', 'target', 'params'} or not isinstance(a['kind'], str) or a['kind'] not in {'goal', 'request', 'program_action', 'message'}: raise ValueError('invalid action')
            text(a['target'])
            if not isinstance(a['params'], dict): raise ValueError('invalid action parameters')
            if e['approver'] is not None: text(e['approver'])
        if kind == 'constraint':
            if not isinstance(e['predicate'], str) or e['predicate'] not in {'all-present', 'distinct-members'}: raise ValueError('unsupported declarative constraint')
            if not isinstance(e['members'], list) or not e['members']: raise ValueError('constraint members required')
            for member in e['members']: text(member)
        if kind == 'subflow':
            text(e['flow_id'])
            d = e['revision_digest']
            if not isinstance(d, str) or len(d) != 64 or any(c not in '0123456789abcdef' for c in d): raise ValueError('subflow requires revision digest')
    def ref(key, kinds):
        if key not in ids or ids[key]['kind'] not in kinds: raise ValueError('missing or mistyped reference')
    ref(flow['entry'], {'node', 'subflow'})
    for e in elements:
        if e['kind'] == 'relation':
            for role in e['roles']: ref(role['member'], {'node', 'relation', 'subflow'})
        if e['kind'] == 'constraint':
            for member in e['members']: ref(member, KINDS)
        if e['kind'] == 'transition':
            ref(e['from'], {'node', 'subflow'}); ref(e['to'], {'node', 'subflow'}); ref(e['trigger'], {'event'})
            for guard in e['guards']: ref(guard, {'constraint'})
            if e['approver'] is not None: ref(e['approver'], {'node'})
    return flow


def revision(flow, layout=None):
    validate(flow)
    layout = {} if layout is None else layout
    _data(layout)
    if not isinstance(layout, dict) or not set(layout) <= {e['id'] for e in flow['elements']}:
        raise ValueError('layout contains unknown element')
    for position in layout.values():
        if not isinstance(position, dict) or set(position) != {'x', 'y'} or any(type(v) not in (int, float) for v in position.values()):
            raise ValueError('invalid canvas position')
    return json.loads(canonical({'body': flow, 'digest': digest(flow), 'layout': layout, 'execution_authority': 'none'}))


def check_structure(flow):
    """Offline diagnostics. Does not authenticate refs or authorize actions."""
    validate(flow)
    reached = {flow['entry']}
    transitions = [e for e in flow['elements'] if e['kind'] == 'transition']
    while True:
        more = {t['to'] for t in transitions if t['from'] in reached} - reached
        if not more: break
        reached |= more
    findings = []
    for e in flow['elements']:
        if e['kind'] in {'node', 'subflow'} and e['props'].get('control_step') is True and e['id'] not in reached:
            findings.append({'code': 'unreachable-step', 'element': e['id']})
        if e['kind'] == 'transition' and e['props'].get('requires_approval') is True and e['approver'] is None:
            findings.append({'code': 'missing-approver', 'element': e['id']})
        if e['kind'] == 'constraint' and e['predicate'] == 'distinct-members' and len(set(e['members'])) != len(e['members']):
            findings.append({'code': 'constraint-failed', 'element': e['id']})
    return {'flow_digest': digest(flow), 'findings': findings, 'execution_authorized': False,
            'authority_checks': 'host-required', 'scope': 'structural-only'}
