"""Retain benchmark imports in the existing Evolve registry, with no adoption."""
import json
from .protocol import seal, compare


def _owner(actor, swarm_id):
    # One source for "the hive owner": EvolveRegistry.named_owner (the owner, 2026-10-04: a named admin person stands for it).
    from hive.core.evolve import EvolveRegistry
    if not EvolveRegistry.named_owner(actor, swarm_id):
        raise PermissionError('named hive owner required for benchmark evidence import')


def register(registry, swarm_id, actor, registration):
    _owner(actor,swarm_id)
    registered_pin=seal(registration)
    if len(json.dumps(registration,allow_nan=False))>32000:
        raise ValueError('registration exceeds 32 KiB; use a preregistered cohort')
    return registry.append(swarm_id,'benchmark',actor['principal'],
                           {'title':registration['benchmark']+' '+registration['release'],
                            'registration':registration,'registration_pin':registered_pin,
                            'state':'benchmark-registered','custody':'unresolved',
                            'candidate_evaluated':False,'adoption_authorized':False})


def assess(registry, swarm_id, actor, benchmark_id, export):
    _owner(actor,swarm_id)
    rows=registry.records(swarm_id,benchmark_id)
    if not rows or rows[0]['kind']!='benchmark':
        raise ValueError('benchmark registration must belong to this swarm')
    if not isinstance(export,dict) or len(json.dumps(export,allow_nan=False))>512000:
        raise ValueError('normalized export must be an object no larger than 500 KiB')
    source_kind=export.get('source_kind','supplied-trials')
    if source_kind not in ('imported','supplied-trials','local-grid-diagnostic'):
        raise ValueError('supported evidence source kind required')
    body=rows[0]['body']
    assessment=compare(body['registration'],body['registration_pin'],export)
    # A host author retaining evidence does not authenticate external grading.
    return registry.append(swarm_id,'benchmark-assessment',actor['principal'],
                           {'title':'Benchmark assessment: '+assessment['benchmark'],
                            'benchmark_id':benchmark_id,'state':assessment['state'],
                            'assessment':assessment,'source_kind':source_kind,
                            'candidate_evaluated':False,'independent_review':'pending',
                            'beneficialness':'unassessed','adoption_authorized':False})


def assess_receipt(registry, swarm_id, actor, benchmark_id, export, packet, verifier):
    """Trusted host supplies the verifier; person-supplied keys are never admitted.

    Receipt admission is durable before registry append. Identical retry can
    complete a failed append, while differing reuse of the run is refused.
    The host action refuses admission unless a host-provisioned verifier exists.
    """
    _owner(actor, swarm_id)
    rows = registry.records(swarm_id, benchmark_id)
    if not rows or rows[0]['kind'] != 'benchmark':
        raise ValueError('benchmark registration must belong to this swarm')
    if not isinstance(export, dict) or len(json.dumps(export, allow_nan=False)) > 512000:
        raise ValueError('normalized export must be an object no larger than 500 KiB')
    registration = rows[0]['body']['registration']
    assessment = compare(registration, rows[0]['body']['registration_pin'], export)
    authentication = verifier.admit(packet, registration, export,
                                    swarm_id=swarm_id, benchmark_id=benchmark_id)
    return registry.append(swarm_id, 'benchmark-assessment', actor['principal'],
                           {'title': 'Authenticated report: ' + assessment['benchmark'],
                            'benchmark_id': benchmark_id, 'state': assessment['state'],
                            'assessment': assessment, 'receipt_authentication': authentication,
                            'source_kind': 'authenticated-report', 'candidate_evaluated': False,
                            'independent_review': 'pending', 'beneficialness': 'unassessed',
                            'adoption_authorized': False})
