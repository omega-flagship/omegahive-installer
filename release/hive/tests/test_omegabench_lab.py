from hive.tests.omegabench_fixtures import client
from hive.tests.test_lab_api import wait_run


def test_omegabench_development_visible_and_persisted(client):
    suites={s['id']:s for s in client.get('/api/lab/suites').json()}
    assert suites['tests-omegabench']['runnable']
    assert 'no Omega subject' in suites['bench-omega-development']['description']
    run=client.post('/api/lab/runs',json={'suite':'bench-omega-development'}).json()
    done=wait_run(client,run['id'],timeout=15)
    assert done['status']=='passed' and len(done['cases'])==3
    assert all(c['dimension']=='benchmark-fixture' for c in done['cases'])
    history=client.get('/api/lab/history/bench-omega-development').json()
    assert history['runs'][-1]['id']==run['id']
    assert 'capability' not in {d['dimension'] for d in client.get('/api/lab/scorecard').json()}


def test_qualification_run_attaches_to_evolve_without_capability_claim(client):
    from hive.tests.test_evolve import actor, registration
    hive=client.app.state.hive
    from hive.core.evolve import EvolveRegistry
    registry=EvolveRegistry(hive)
    experiment=registry.register('synthetic-bench-swarm',actor('synthetic-bench-swarm',owner=True),registration())
    run=client.post('/api/lab/runs',json={'suite':'tests-omegabench'}).json()
    done=wait_run(client,run['id'],timeout=20)
    assert done['status']=='passed' and done['cases']
    receipt=registry.lab_receipt('synthetic-bench-swarm',actor('synthetic-bench-swarm',owner=True),experiment['id'],run['id'])
    assert receipt['body']['state']=='protocol-qualified'
    assert not receipt['body']['candidate_evaluated'] and not receipt['body']['adoption_authorized']
    demo=client.post('/api/lab/runs',json={'suite':'bench-omega-development'}).json()
    wait_run(client,demo['id'],timeout=15)
    import pytest
    with pytest.raises(ValueError):
        registry.lab_receipt('synthetic-bench-swarm',actor('synthetic-bench-swarm',owner=True),experiment['id'],demo['id'])
