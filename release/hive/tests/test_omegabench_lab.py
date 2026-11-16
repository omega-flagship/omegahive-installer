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


def test_omegabench_protocol_suite_runs_in_lab(client):
    run=client.post('/api/lab/runs',json={'suite':'tests-omegabench'}).json()
    done=wait_run(client,run['id'],timeout=20)
    assert done['status']=='passed' and done['cases']
