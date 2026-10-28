"""Invented garden sign-up; no personal data or outbound actions."""
def garden():
    def base(eid, kind, **fields):
        return {'id': eid, 'kind': kind, 'props': {}, 'meta': {
            'origin': 'asserted', 'confidence': None, 'evidence': [],
            'revision_state': 'draft', 'runtime_state': 'idle'}, **fields}
    nodes = [base(i, 'node', type='step', ref=None) for i in ('visitor', 'signup', 'review', 'welcome')]
    for n in nodes: n['props']['control_step'] = True
    nodes += [base('person', 'node', type='person', ref='synthetic:operator'),
              base('garden', 'node', type='garden', ref=None),
              base('role', 'node', type='volunteer-role', ref=None)]
    events = [base('submitted', 'event', type='synthetic.submitted'), base('accepted', 'event', type='synthetic.accepted')]
    transitions = []
    for i, (a, b) in enumerate(zip(('visitor', 'signup', 'review'), ('signup', 'review', 'welcome'))):
        t = base('t' + str(i), 'transition', **{'from': a, 'to': b, 'trigger': 'accepted' if i == 2 else 'submitted',
                 'guards': [], 'approver': 'person' if i == 2 else None,
                 'action': {'kind': 'goal', 'target': 'synthetic:garden-service', 'params': {'step': b}}})
        t['props']['requires_approval'] = i == 2
        transitions.append(t)
    relation = base('volunteers', 'relation', type='volunteers-for', roles=[
        {'name': 'volunteer', 'member': 'visitor'}, {'name': 'garden', 'member': 'garden'}, {'name': 'role', 'member': 'role'}])
    about = base('attests', 'relation', type='attestation', roles=[
        {'name': 'subject', 'member': 'volunteers'}, {'name': 'author', 'member': 'person'}])
    return {'schema': 'omegaflow/1', 'id': 'synthetic:garden-signup', 'entry': 'visitor',
            'elements': nodes + events + transitions + [relation, about]}
