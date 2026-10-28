"""Fail-closed preparation for the platform's proposed first execution subset.
This is a structural preflight, never authorization or dispatch.
Current constraints are representation-only and are refused for execution until
shared operational guard semantics are implemented by the platform.
"""
from .model import validate, digest, check_structure

TRIGGERS = {'run.start', 'goal.done', 'goal.failed', 'request.completed'}
ACTIONS = {'goal', 'request', 'message'}


def prepare(flow):
    validate(flow)
    elements = {e['id']: e for e in flow['elements']}
    transitions = {eid:e for eid,e in elements.items() if e['kind']=='transition'}
    failures = list(check_structure(flow)['findings'])
    def refuse(code,eid): failures.append({'code':code,'element':eid})
    if not transitions: refuse('no-executable-transitions',flow['id'])
    # Reified knowledge relations remain legal; they do not schedule anything.
    for e in elements.values():
        if e['kind']=='subflow': refuse('unresolved-subflow',e['id'])
    for t in transitions.values():
        event=elements[t['trigger']]
        if event['type'] not in TRIGGERS: refuse('unsupported-trigger',t['id'])
        if t['action']['kind'] not in ACTIONS: refuse('unsupported-action',t['id'])
        if t['guards']: refuse('guard-execution-unqualified',t['id'])
        if t['props'].get('requires_approval') is True:
            # A named approver is not an actual approval or qualified host gate.
            refuse('approval-execution-unqualified',t['id'])
        if t['meta']['revision_state']!='adopted': refuse('transition-not-adopted',t['id'])
        if event['type']=='run.start':
            if t['from']!=flow['entry']: refuse('start-outside-entry',t['id'])
            if 'source_transition' in event['props']: refuse('start-has-source',t['id'])
        else:
            source=event['props'].get('source_transition')
            if not isinstance(source,str) or source not in transitions:
                refuse('missing-run-local-source',t['id']);continue
            parent=transitions[source]
            if parent['to']!=t['from']: refuse('source-state-mismatch',t['id'])
            expected='request' if event['type']=='request.completed' else 'goal'
            if parent['action']['kind']!=expected: refuse('source-action-mismatch',t['id'])
    # No execution cycles or joins in this conservative subset. AND joins need
    # qualified predecessor guards and a host race-safe admission transaction.
    incoming={}
    for t in transitions.values(): incoming.setdefault(t['to'],[]).append(t['id'])
    for target,items in incoming.items():
        if len(items)>1: refuse('join-execution-unqualified',target)
    indegree={eid:0 for eid,e in elements.items() if e['kind'] in {'node','subflow'}}
    outgoing={eid:[] for eid in indegree}
    for t in transitions.values():
        outgoing[t['from']].append(t['to']);indegree[t['to']]+=1
    todo=sorted(eid for eid,n in indegree.items() if n==0);visited=[]
    while todo:
        eid=todo.pop(0);visited.append(eid)
        for target in outgoing[eid]:
            indegree[target]-=1
            if indegree[target]==0: todo.append(target)
    if len(visited)!=len(indegree): refuse('cycle-execution-unqualified',flow['id'])
    # Disconnected execution branches may not hide as unmarked concept nodes.
    reached={flow['entry']}
    while True:
        more={t['to'] for t in transitions.values() if t['from'] in reached}-reached
        if not more: break
        reached|=more
    for t in transitions.values():
        if t['from'] not in reached: refuse('unreachable-transition',t['id'])
    return {'flow_digest':digest(flow),'subset':'omegaflow-preflight/1',
            'structurally_eligible':not failures,'findings':failures,
            'execution_authorized':False,'host_requirements':[
                'authenticated adopted artifact revision',
                'current actor lease, visibility and action-specific policy',
                'atomic idempotent admission and dispatch recovery',
                'event-to-owned-goal/request binding',
                'result validation and review before completion',
                'authority recheck, cancellation and immutable run receipts']}
