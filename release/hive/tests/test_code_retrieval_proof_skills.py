"""Actual membrane and proxy registration; synthetic transport, no model call."""
import json
import tomllib
from hive.tests.test_code_evidence_skills import membrane,oc,MODULE


def test_retrieval_is_bound_and_does_not_change_edit_observations(membrane):
    client,calls=membrane;before=oc._state_path().read_bytes()
    client.result={'ok':True,'result':{'workspace_id':'ws_one','generation':7,'tree_digest':'tree7',
        'index_digest':'index','mode':'lexical','provider_calls':0,'symbolic_publication':False,
        'results':[{'chunk_id':'chunk','path':'x.py','source_digest':'source','start_line':1,'end_line':40,'text':'x'*10000}]}}
    page=json.loads(oc.retrieve('cache').split('only ',1)[1])
    assert page['mode']=='lexical' and page['results'][0]['text_truncated']
    assert len(page['results'][0]['text'])==600 and page['results'][0]['source_digest']=='source'
    assert calls[-1][0]=='repository-retrieval' and calls[-1][3]=={'workspace_id':'ws_one','expected_generation':7,'expected_tree_digest':'tree7','query':'cache','limit':5}
    assert oc._state_path().read_bytes()==before


def test_proof_summary_retains_unknown_applicability_and_full_output_route(membrane):
    client,calls=membrane;before=oc._state_path().read_bytes()
    client.result={'ok':True,'result':{'run_id':'run_old','status':'audit-refused','currency':'historical',
        'implementation_applicability':'unverified','output_digest':'digest','result':{'theorems':[{'theorem':'unfinished','axioms':['sorryAx']}]}}}
    page=json.loads(oc.proof_result('run_old').removeprefix('CODE-PROOF-RESULT '))
    assert page['status']=='audit-refused' and page['currency']=='historical'
    assert page['theorems'][0]['axioms']==['sorryAx'] and not page['details_complete']
    assert page['details_command']=='code-output run_old 0' and calls[-1][0]=='proof-result'
    assert oc._state_path().read_bytes()==before


def test_proof_run_uses_enabled_discovery_last_read_and_exact_approval_retry(membrane):
    client,calls=membrane
    state=oc._load();state['files']['Proof.lean']={'digest':'source','generation':6,'tree_digest':'tree6'};oc._save(state)
    def invoke(action,task,repo,payload):
        calls.append((action,task,repo,payload))
        if action=='toolchains':return {'ok':True,'result':{'toolchains':[{'id':'lean','capabilities':['lean-single-module-check'],'check_argv_prefix':['/operator/lean']}]}}
        if 'approval_id' not in payload:return {'ok':False,'result':{'error':'approval_required','details':{'approval_id':'p_one'}}}
        return {'ok':True,'result':{'id':'run_proof','status':'running'}}
    client.call=invoke
    assert 'CODE-APPROVAL-NEEDED' in oc.proof_check('lean','Proof.lean')
    first=dict(calls[-1][3]);assert first['expected_generation']==6 and first['expected_tree_digest']=='tree6'
    assert first['argv']==['/operator/lean','Proof.lean'] and first['proof_runtime_id']=='lean'
    assert 'CODE-PROOF-RUN' in oc.proof_check('lean','Proof.lean')
    assert calls[-1][3]=={**first,'approval_id':'p_one'} and oc._load()['run']=='run_proof'


def test_unread_or_disabled_proofs_do_not_execute(membrane):
    client,calls=membrane
    assert 'proof_source' in oc.proof_check('lean','not-read.lean') and not calls
    state=oc._load();state['files']['Proof.lean']={'generation':7,'tree_digest':'tree7'};oc._save(state)
    client.result={'ok':True,'result':{'toolchains':[{'id':'lean','capabilities':[]}]}}
    assert 'proof_runtime' in oc.proof_check('lean','Proof.lean')
    assert all(c[0]=='toolchains' for c in calls)


def test_native_registry_is_complete():
    manifest=tomllib.loads((MODULE/'module.toml').read_text())
    for skill,fn in [('code-retrieve','retrieve'),('code-proof-result','proof_result'),('code-proof-check','proof_check')]:
        assert 'skill:'+skill in manifest['provides'] and callable(getattr(oc,fn))
        for name in ['entry.metta','skills.metta','signatures.metta','catalog.metta','affordance.metta']:
            assert skill in (MODULE/name).read_text()


def test_oversized_metadata_is_explicitly_refused_without_advancing_state(membrane):
    client,calls=membrane;before=oc._state_path().read_bytes()
    client.result={'ok':True,'result':{'scope':'x'*20000,'results':[]}}
    assert 'retrieval_view_too_large' in oc.retrieve('cache')
    client.result={'ok':True,'result':{'reason':'x'*20000,'result':{}}}
    assert 'proof_view_too_large' in oc.proof_result('run_old')
    assert oc._state_path().read_bytes()==before
