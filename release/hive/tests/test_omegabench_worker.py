from types import SimpleNamespace
from hive.core.db import Database
from hive.core.evolve import EvolveRegistry
from hive.tests.test_evolve import actor
from hive.plugins.omegaevolve import program
from omegabench.tests.test_worker import setup
from omegabench.worker import run
from omegabench.protocol import digest
from omegabench.receipts import issue, ReceiptVerifier
from omegabench.evolve_bridge import register, assess_receipt


def test_prompt_grading_to_bound_receipt_to_evolve_graph(tmp_path):
    r,pack,executors,requests=setup()
    registry=EvolveRegistry(SimpleNamespace(db=Database(tmp_path/'hive.sqlite')))
    owner=actor(owner=True);benchmark=register(registry,'s1',owner,r)
    export,audit=run(r,pack,executors)
    key=b'disposable-worker-to-host-shared-key-32bytes'
    packet=issue(r,export,issuer='bench:worker',key_id='k1',key=key,run_id='paired-synthetic-1',
                 swarm_id='s1',benchmark_id=benchmark['id'],custody_manifest_pin=digest({'audit_digest':audit['events_digest'],'custody':'synthetic-public-development; unverified'}))
    verifier=ReceiptVerifier(tmp_path/'receipt.sqlite',{('bench:worker','k1'):key})
    retained=assess_receipt(registry,'s1',owner,benchmark['id'],export,packet,verifier)
    ctx=SimpleNamespace(evolve_snapshot=lambda focus:registry.snapshot('s1',focus))
    graph=program.view(ctx,None,'unfold')
    item=next(i for i in graph['items'] if i['id']==retained['id'])
    assert item['meta']['assessment']['arms']['candidate']['solved']==12
    assert item['meta']['assessment']['gain']==0
    assert item['meta']['assessment']['evidence_tier']=='unverified-import'
    assert item['meta']['receipt_authentication']['transport']=='authenticated-local-mac'
    assert not item['meta']['candidate_evaluated'] and not item['meta']['adoption_authorized']
    assert 'expected' not in str(requests)
    assert key.decode() not in str(graph)
    assert audit['commitment_nonce'] not in str(graph)
    assert 'response' not in audit['events'][0]
    verifier.close();registry.db._conn.close()
