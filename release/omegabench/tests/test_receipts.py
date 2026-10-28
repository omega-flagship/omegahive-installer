import copy
from concurrent.futures import ThreadPoolExecutor
import pytest
from omegabench.demo import example
from omegabench.receipts import ReceiptVerifier, issue

KEY = b'synthetic-disposable-key-not-for-production-32'


def fixture(tmp_path):
    registration, export, _ = example()
    packet = issue(registration, export, issuer='bench:evaluator', key_id='k1', key=KEY,
                   run_id='run-1', swarm_id='s1', benchmark_id='b1', custody_manifest_pin='a'*64)
    verifier = ReceiptVerifier(tmp_path/'receipts.sqlite', {('bench:evaluator','k1'):KEY})
    return registration, export, packet, verifier


def admit(verifier, packet, registration, export, **context):
    return verifier.admit(packet, registration, export,
                          **dict({'swarm_id':'s1', 'benchmark_id':'b1'}, **context))


def test_bound_receipt_idempotent_restart_and_no_authority(tmp_path):
    r,e,p,v = fixture(tmp_path)
    first = admit(v,p,r,e)
    assert first['transport']=='authenticated-local-mac'
    assert first['custody']=='unverified'
    assert first['candidate_evaluated'] is first['adoption_authorized'] is False
    assert admit(v,p,r,e)==first
    v.close()
    v=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    assert admit(v,p,r,e)==first
    v.close()


@pytest.mark.parametrize('field',['export_digest','candidate_pin','custody_manifest_pin','issuer','key_id','run_id'])
def test_tampered_packet_refused(tmp_path,field):
    r,e,p,v=fixture(tmp_path)
    p['payload'][field]='b'*64
    with pytest.raises(PermissionError):admit(v,p,r,e)
    v.close()


@pytest.mark.parametrize('context',[{'swarm_id':'other'}, {'benchmark_id':'other'}])
def test_replay_in_other_context_refused(tmp_path,context):
    r,e,p,v=fixture(tmp_path)
    with pytest.raises(ValueError):admit(v,p,r,e,**context)
    v.close()


def test_export_or_registration_change_refused(tmp_path):
    r,e,p,v=fixture(tmp_path)
    changed=copy.deepcopy(e);changed['candidate'][0]['score']=0
    with pytest.raises(ValueError):admit(v,p,r,changed)
    changed=copy.deepcopy(r);changed['candidate_pin']='b'*64
    with pytest.raises(ValueError):admit(v,p,changed,e)
    v.close()


def test_valid_mac_different_run_reuse_refused(tmp_path):
    r,e,p,v=fixture(tmp_path);admit(v,p,r,e)
    changed=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='run-1',
                  swarm_id='s1',benchmark_id='b1',custody_manifest_pin='b'*64)
    with pytest.raises(ValueError):admit(v,changed,r,e)
    v.close()


def test_revocation_persists_and_applies_to_retry(tmp_path):
    r,e,p,v=fixture(tmp_path);admit(v,p,r,e);v.revoke('bench:evaluator','k1');v.close()
    v=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    with pytest.raises(PermissionError):admit(v,p,r,e)
    v.close()


def test_unknown_issuer_and_weak_key_refused(tmp_path):
    r,e,p,v=fixture(tmp_path)
    unknown=ReceiptVerifier(':memory:',{})
    with pytest.raises(PermissionError):admit(unknown,p,r,e)
    with pytest.raises(ValueError):ReceiptVerifier(':memory:',{('a','k'):b'weak'})
    v.close();unknown.close()


def test_incomplete_denominator_cannot_be_issued(tmp_path):
    r,e,p,v=fixture(tmp_path);e['candidate'].pop()
    with pytest.raises(ValueError):issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,
                   run_id='run-2',swarm_id='s1',benchmark_id='b1',custody_manifest_pin='a'*64)
    v.close()


def test_separate_connections_admit_identical_receipt(tmp_path):
    r,e,p,v=fixture(tmp_path)
    other=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    with ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda verifier:admit(verifier,p,r,e),[v,other]))
    assert results[0]==results[1]
    v.close();other.close()


def test_conflicting_concurrent_receipts_one_wins(tmp_path):
    r,e,p,v=fixture(tmp_path)
    other=ReceiptVerifier(tmp_path/'receipts.sqlite',{('bench:evaluator','k1'):KEY})
    changed=issue(r,e,issuer='bench:evaluator',key_id='k1',key=KEY,run_id='run-1',
                  swarm_id='s1',benchmark_id='b1',custody_manifest_pin='b'*64)
    def attempt(pair):
        verifier,packet=pair
        try:return admit(verifier,packet,r,e)
        except ValueError:return None
    with ThreadPoolExecutor(2) as pool:
        results=list(pool.map(attempt,[(v,p),(other,changed)]))
    assert sum(result is not None for result in results)==1
    assert v._db.execute('SELECT count(*) FROM receipts').fetchone()[0]==1
    v.close();other.close()
