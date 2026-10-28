"""Lossless fixed-predicate MeTTa data encoding; imported text is UTF-8 hex.

Recovery parses this finite format; it never calls eval or a MeTTa interpreter.
Field atoms retain full JSON values, while Role/Transition atoms expose structure.
"""
import json
import re
from .model import canonical, digest, validate

PATTERN = re.compile(r'\((OF[A-Za-z]+)(?: "[0-9a-f]*")+\)')


def token(value):
    return canonical(value).encode().hex()


def atom(predicate, *values):
    return '(' + predicate + ' ' + ' '.join('"' + token(v) + '"' for v in values) + ')'


def project(flow):
    validate(flow)
    d = digest(flow)
    atoms = [atom('OFFlow', d, flow['schema'], flow['id'], flow['entry'])]
    for position, e in enumerate(flow['elements']):
        atoms.append(atom('OFElement', d, e['id'], position, e['kind']))
        for key, value in sorted(e.items()):
            if key not in {'id', 'kind'}: atoms.append(atom('OFField', d, e['id'], key, value))
        if e['kind'] == 'relation':
            for index, role in enumerate(e['roles']):
                atoms.append(atom('OFRole', d, e['id'], role['name'], index, role['member']))
        if e['kind'] == 'transition': atoms.append(atom('OFTransition', d, e['id'], e['from'], e['to']))
    return sorted(atoms)


def recover(atoms):
    if not isinstance(atoms, list) or not atoms or len(atoms) > 16000: raise ValueError('invalid atom count')
    if any(not isinstance(a, str) for a in atoms): raise ValueError('atoms must be strings')
    if sum(len(a) for a in atoms) > 2097152: raise ValueError('atom size limit')
    if len(atoms) != len(set(atoms)): raise ValueError('duplicate atom')
    rows = []
    for a in atoms:
        if not PATTERN.fullmatch(a): raise ValueError('unsupported atom syntax')
        p = a[1:a.index(' ')]
        try: values = [json.loads(bytes.fromhex(h).decode()) for h in re.findall(r'"([0-9a-f]*)"', a)]
        except (ValueError, UnicodeError): raise ValueError('invalid encoded value') from None
        rows.append((p, values))
    headers = [v for p, v in rows if p == 'OFFlow']
    if len(headers) != 1 or len(headers[0]) != 4: raise ValueError('one header required')
    d, schema, fid, entry = headers[0]
    elements = {}; positions = {}
    for p, v in rows:
        if not v or v[0] != d: raise ValueError('mixed revision')
        if p == 'OFElement':
            if len(v) != 4: raise ValueError('invalid element atom')
            _, eid, pos, kind = v
            if not isinstance(eid, str) or eid in elements or type(pos) is not int or pos < 0 or pos in positions: raise ValueError('invalid element order')
            elements[eid] = {'id': eid, 'kind': kind}; positions[pos] = eid
    if sorted(positions) != list(range(len(elements))): raise ValueError('noncontiguous element order')
    for p, v in rows:
        if p == 'OFField':
            if len(v) != 4: raise ValueError('invalid field atom')
            _, eid, key, value = v
            if eid not in elements or not isinstance(key, str) or key in elements[eid]: raise ValueError('invalid field owner or duplicate field')
            elements[eid][key] = value
    flow = {'schema': schema, 'id': fid, 'entry': entry, 'elements': [elements[positions[i]] for i in range(len(elements))]}
    validate(flow)
    if digest(flow) != d or project(flow) != sorted(atoms): raise ValueError('projection differs from source revision')
    return flow
