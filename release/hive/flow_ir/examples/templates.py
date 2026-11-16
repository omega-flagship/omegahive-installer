"""Public, invented authoring starters. No identities, live targets or adoption."""
from ..model import revision
from .garden import garden


def element(eid, kind, label, **fields):
    return {'id': eid, 'kind': kind, 'props': {'label': label}, 'meta': {
        'origin': 'asserted', 'confidence': None, 'evidence': [],
        'revision_state': 'draft', 'runtime_state': 'idle'}, **fields}


def node(eid, label, kind='concept', step=False):
    value = element(eid, 'node', label, type=kind, ref=None)
    if step: value['props']['control_step'] = True
    return value


def relation(eid, label, roles):
    return element(eid, 'relation', label, type=eid,
                   roles=[{'name': name, 'member': member} for name, member in roles])


def chain(key, stages, extra):
    nodes = [node(eid, label, 'step', True) for eid, label in stages]
    events = [element('step-ready', 'event', 'Step ready', type='draft.step-ready')]
    transitions = []
    for i, ((source, _), (target, label)) in enumerate(zip(stages, stages[1:])):
        transitions.append(element(f't{i}', 'transition', f'To {label}', **{
            'from': source, 'to': target, 'trigger': 'step-ready', 'guards': [],
            'approver': None, 'action': {'kind': 'goal', 'target': 'draft:choose-swarm',
                                      'params': {'title': label}}}))
    return {'schema': 'omegaflow/1', 'id': 'draft:' + key, 'entry': stages[0][0],
            'elements': nodes + extra + events + transitions}


def layout(flow):
    out = {}; groups = {'step': 0, 'other': 0, 'relation': 0, 'event': 0}
    for e in flow['elements']:
        if e['kind'] == 'transition': continue
        group = 'step' if e['props'].get('control_step') else e['kind'] if e['kind'] in {'relation', 'event'} else 'other'
        i = groups[group]; groups[group] += 1
        row = {'step': 170, 'other': 410, 'relation': 620, 'event': 820}[group]
        out[e['id']] = {'x': 120 + (i % 4) * 270, 'y': row + (i // 4) * 115}
    return out


def catalogue():
    workflow = chain('task-review', [('intake','Intake'),('work','Do the work'),('review','Review'),('finish','Finish')], [
        node('owner','Work owner','person'), node('reviewer','Reviewer','person'),
        relation('responsibility','Work responsibility',[('work','work'),('owner','owner'),('reviewer','reviewer')])])
    # A review label describes intent; it is not operational approval. Authors
    # must bind targets and use the host's explicit review/adoption mechanisms.
    handoff = chain('interaction-handoff', [('request','Request'),('clarify','Clarify'),('handoff','Hand off'),('acknowledge','Acknowledge')], [
        node('sender','Sender','person'), node('receiver','Receiver','person'), node('channel','Communication channel','channel'),
        relation('participants','Handoff participants',[('sender','sender'),('receiver','receiver'),('channel','channel')]),
        relation('accountability','Handoff ownership',[('handoff','participants'),('accountable','sender')])])
    funnel = chain('lead-funnel', [('discover','Discover'),('interest','Interest'),('qualify','Qualify'),('convert','Convert')], [
        node('audience','Audience segment','concept'), node('offer','Offer','concept'), node('outcome','Desired outcome','concept'),
        relation('funnel-context','Funnel context',[('audience','audience'),('offer','offer'),('outcome','outcome')])])
    connections = {'schema':'omegaflow/1','id':'draft:connection-map','entry':'requester','elements':[
        node('requester','Requesting swarm','swarm'),node('provider','Providing swarm','swarm'),
        node('service','Service','service'),node('scope','Agreed scope','concept'),node('owner','Connection owner','person'),
        relation('connection','Proposed connection',[('requester','requester'),('provider','provider'),('service','service'),('scope','scope')]),
        relation('connection-ownership','Connection ownership',[('connection','connection'),('owner','owner')]) ]}
    entries = [
        ('task-review','Task review workflow','Workflow','Arrange intake, work, review and completion. Review remains a design step until explicitly configured.',workflow),
        ('lead-funnel','Lead funnel','Funnel','Map discovery, interest, qualification and conversion with an audience, offer and outcome.',funnel),
        ('interaction-handoff','Interaction handoff','Interaction','Map the exchange and its participants, channel and accountable owner.',handoff),
        ('connection-map','Connection map','Connections','Explore a service connection and its scope. Drawing a connection grants no access.',connections),
        ('garden-signup','Garden volunteer sign-up','Example','The invented garden example with n-ary participation and a relation about that relation.',garden())]
    return [{'key':key,'title':title,'category':category,'description':description,
             'revision':revision(body,layout(body))} for key,title,category,description,body in entries]
