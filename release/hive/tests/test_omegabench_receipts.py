from types import SimpleNamespace
import pytest
from hive.core.db import Database
from hive.core.evolve import EvolveRegistry
from hive.tests.test_evolve import actor
from omegabench.demo import example
from omegabench.evolve_bridge import register, assess_receipt
from omegabench.receipts import ReceiptVerifier, issue
from hive.plugins.omegaevolve import program

KEY=b'synthetic-host-evaluator-key-not-a-live-secret'


def test_bound_report_retained_without_authority_and_retry_safe(tmp_path):
    registry=EvolveRegistry(SimpleNamespace(db=Database(tmp_path/'hive.sqlite')))
    r,e,_=example();owner=actor(owner=True);benchmark=register(registry,'s1',owner,r)
    verifier=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    packet=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='r1',
                 swarm_id='s1',benchmark_id=benchmark['id'],custody_manifest_pin='a'*64)
    result=assess_receipt(registry,'s1',owner,benchmark['id'],e,packet,verifier)
    assert assess_receipt(registry,'s1',owner,benchmark['id'],e,packet,verifier)['id']==result['id']
    ctx=SimpleNamespace(evolve_snapshot=lambda focus:registry.snapshot('s1',focus))
    graph=program.view(ctx,None,'unfold')
    item=next(i for i in graph['items'] if i['id']==result['id'])
    assert item['meta']['assessment']['independent_units']==3
    assert item['meta']['assessment']['evidence_tier']=='unverified-import'
    authentication=item['meta']['receipt_authentication']
    assert authentication['transport']=='authenticated-local-mac'
    assert authentication['custody']=='unverified'
    assert item['meta']['candidate_evaluated'] is item['meta']['adoption_authorized'] is False
    assert 'mac' not in authentication and 'payload' not in authentication
    assert KEY.decode() not in str(graph)
    verifier.revoke('bench:evaluator','k1')
    with pytest.raises(PermissionError):assess_receipt(registry,'s1',owner,benchmark['id'],e,packet,verifier)
    verifier.close();registry.db._conn.close()


def test_refused_owner_does_not_consume_receipt(tmp_path):
    registry=EvolveRegistry(SimpleNamespace(db=Database(tmp_path/'hive.sqlite')))
    r,e,_=example();owner=actor(owner=True);benchmark=register(registry,'s1',owner,r)
    verifier=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    packet=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='r1',
                 swarm_id='s1',benchmark_id=benchmark['id'],custody_manifest_pin='a'*64)
    with pytest.raises(PermissionError):assess_receipt(registry,'s1',actor(),benchmark['id'],e,packet,verifier)
    assert verifier._db.execute('SELECT count(*) FROM receipts').fetchone()[0]==0
    verifier.close();registry.db._conn.close()


def test_registry_failure_can_retry_authenticated_report(tmp_path):
    real=EvolveRegistry(SimpleNamespace(db=Database(tmp_path/'hive.sqlite')))
    r,e,_=example();owner=actor(owner=True);benchmark=register(real,'s1',owner,r)
    verifier=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    packet=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='r1',
                 swarm_id='s1',benchmark_id=benchmark['id'],custody_manifest_pin='a'*64)
    def failed_append(*args):raise RuntimeError('disposable append failure')
    failing=SimpleNamespace(records=real.records,append=failed_append)
    with pytest.raises(RuntimeError):assess_receipt(failing,'s1',owner,benchmark['id'],e,packet,verifier)
    result=assess_receipt(real,'s1',owner,benchmark['id'],e,packet,verifier)
    assert result['body']['receipt_authentication']['run_id']=='r1'
    verifier.close();real.db._conn.close()

from hive.tests.omegabench_fixtures import client


def test_real_api_host_configured_receipt_path_and_stale_refusal(client,tmp_path):
    from hive.tests.test_visibility import person
    headers=person(client,'u_bench_receipt_owner',role='owner')
    swarm=client.post('/api/swarms',headers=headers,json={'name':'Synthetic receipt check'}).json()
    sid=swarm['id'];r,e,_=example()
    def view():
        response=client.post('/api/programs/omegaevolve/view',headers=headers,json={'swarm_id':sid})
        assert response.status_code==200,response.text
        return response.json()
    def act(action,items,params,revision):
        response=client.post('/api/programs/omegaevolve/act',headers=headers,json={
            'swarm_id':sid,'action':action,'items':items,'params':params,'base_revision':revision})
        assert response.status_code==200,response.text
        return response.json()
    graph=view()
    first=act('register-benchmark',['objective'],{'registration':r},graph['revision'])
    bid=first['detail']['record_id']
    packet=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='r1',
                 swarm_id=sid,benchmark_id=bid,custody_manifest_pin='a'*64)
    params={'export':e,'receipt':packet,'trusted_keys':{'untrusted':'never accepted'}}
    assert act('attach-benchmark-receipt',[bid],params,view()['revision'])['status']=='refused'
    verifier=ReceiptVerifier(tmp_path/'receipt-ledger.sqlite',{('bench:evaluator','k1'):KEY})
    client.app.state.hive.benchmark_receipt_verifier=verifier
    assert act('attach-benchmark-receipt',[bid],params,graph['revision'])['status']=='stale'
    assert verifier._db.execute('SELECT count(*) FROM receipts').fetchone()[0]==0
    current=view()
    result=act('attach-benchmark-receipt',[bid],params,current['revision'])
    assert result['status']=='done',result
    item=next(i for i in result['graph']['items'] if i['id']==result['detail']['record_id'])
    assert item['meta']['receipt_authentication']['transport']=='authenticated-local-mac'
    assert not item['meta']['candidate_evaluated'] and not item['meta']['adoption_authorized']
    verifier.revoke('bench:evaluator','k1')
    assert act('attach-benchmark-receipt',[bid],params,view()['revision'])['status']=='refused'
    verifier.close()
