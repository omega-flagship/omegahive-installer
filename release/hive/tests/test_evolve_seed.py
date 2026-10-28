import copy

from hive.core.evolve_seed import inspect_pair, seed_plan


def fixture():
    swarm = 's_12345678'
    agents = [dict(id='a_12345678', kind='omega', driver='local', status='stopped', visibility='private', swarm_id=swarm),
              dict(id='a_87654321', kind='iter', driver='docker', status='created', visibility='private', swarm_id=swarm)]
    rules = [dict(scope=f'swarm:{swarm}', period='day', limit_usd=10),
             *[dict(scope=f"agent:{a['id']}", period='total', limit_usd=.5) for a in agents]]
    return swarm, agents, rules, {a['id']: str(n)*64 for n, a in enumerate(agents, 1)}


def test_pair_plan_has_two_evolving_subjects_and_combined_cap():
    p = seed_plan()
    assert [a['kind'] for a in p['members']] == ['omega', 'iter']
    assert len({a['name'] for a in p['members']}) == 2
    assert all('both evolving subjects' in a['persona'] for a in p['members'])
    assert sum(a['budget_usd'] for a in p['members']) == p['budget']['bootstrap_combined_usd'] == 1
    assert p['budget']['swarm_day_usd'] == 10
    assert not p['adoption_authorized']


def test_seed_observation_is_not_runtime_or_adoption_proof_and_drops_credentials():
    args = fixture()
    args[1][0]['token'] = 'must-not-be-retained'
    args[1][0]['options'] = {'key': 'private'}
    before = copy.deepcopy(args)
    receipt = inspect_pair(*args)
    assert receipt['status'] == 'metadata-qualified'
    assert not receipt['runtime_verified'] and not receipt['adoption_authorized']
    assert 'must-not-be-retained' not in str(receipt) and 'private' not in str(receipt)
    assert args == before
    assert inspect_pair(args[0], list(reversed(args[1])), args[2], args[3])['digest'] == receipt['digest']


def test_duplicate_wrong_kind_and_partial_seed_are_held():
    for change in ('duplicate', 'kind', 'partial'):
        swarm, agents, rules, pins = fixture()
        if change == 'duplicate':
            agents[1]['id'] = agents[0]['id']
        elif change == 'kind':
            agents[1]['kind'] = 'module'
        else:
            agents.pop()
        assert inspect_pair(swarm, agents, rules, pins)['status'] == 'held'


def test_unisolated_iter_running_seed_missing_source_and_doubled_budget_are_held():
    for change in ('local', 'running', 'pin', 'budget', 'rule'):
        swarm, agents, rules, pins = fixture()
        if change == 'local':
            agents[1]['driver'] = 'local'
        elif change == 'running':
            agents[0]['status'] = 'running'
        elif change == 'pin':
            pins.clear()
        elif change == 'budget':
            rules[0]['limit_usd'] = 20
        else:
            rules.pop()
        assert inspect_pair(swarm, agents, rules, pins)['errors']


def test_unrelated_minds_cannot_satisfy_pair_or_spend_rules():
    swarm, agents, rules, pins = fixture()
    agents[1]['swarm_id'] = 's_00000000'
    receipt = inspect_pair(swarm, agents, rules, pins)
    assert receipt['status'] == 'held'
    assert len(receipt['subjects']) == 1
