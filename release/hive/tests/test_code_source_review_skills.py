"""Review membrane state and exact approvals; no model/browser claim."""
import importlib.util
import json
import pathlib
import re
import pytest

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('review_membrane', ROOT/'modules/code/src/omega_code.py')
oc=importlib.util.module_from_spec(spec);spec.loader.exec_module(oc)

@pytest.fixture
def membrane(tmp_path,monkeypatch):
    monkeypatch.setenv('OMEGACLAW_MEMORY_DIR',str(tmp_path))
    oc._save({'goal':'g_one','repo':'synthetic','ws':'ws_one','generation':7,'tree_digest':'tree7',
        'files':{'x':{'digest':'old','content':'read before'}},'pending':{}})
    calls=[]
    class Client:
        result={}
        def call(self,action,task,repo,payload): calls.append((action,payload));return self.result
        def close(self): pass
    client=Client();monkeypatch.setattr(oc,'_client',lambda:(client,None))
    return client,calls


def test_frozen_review_keeps_edit_read_state_and_pages_bytes(membrane):
    client,calls=membrane
    client.result={'ok':True,'result':{'id':'review_one','generation':7,'tree_digest':'tree7'}}
    assert oc.review_create('base').startswith('CODE-REVIEW ')
    assert calls[-1][1]['target']=='base'
    assert oc._load()['files']['x']['digest']=='old'
    before=oc._state_path().read_bytes()
    client.result={'ok':True,'result':{'currency':'stale','data':'8J8=','cursor':2}}
    oc.review_hunks('review_one','5');assert calls[-1]==('review-state',{'workspace_id':'ws_one','review_id':'review_one','after':5,'limit':5})
    page=json.loads(oc.review_content('review_one','h_one','after','0').removeprefix('CODE-HUNK-BYTES '))
    assert page['data']=='8J8=' and calls[-1][1]['limit']==1024
    assert oc._state_path().read_bytes()==before


def test_selection_retries_exact_approved_payload_and_clears_old_file_reads(membrane):
    client,calls=membrane
    client.result={'ok':True,'result':{'id':'review_one','generation':7,'tree_digest':'tree7'}}
    oc.review_create('base')
    client.result={'ok':False,'http_status':403,'result':{'error':'approval_required','details':{'approval_id':'p_one'}}}
    assert 'APPROVAL-NEEDED p_one' in oc.review_apply('review_one','h_b h_a')
    approved=calls[-1][1]
    state=oc._load();state['generation']=8;state['tree_digest']='other';oc._save(state)
    client.result={'ok':True,'result':{'workspace':{'id':'ws_one','generation':9,'tree_digest':'tree9'},'change':{'id':'cs_one'}}}
    assert oc.review_apply('review_one','h_a h_b').startswith('CODE-SELECTED ')
    assert calls[-1][1]==approved|{'approval_id':'p_one'}
    assert approved['hunk_ids']==['h_a','h_b'] and approved['expected_generation']==7
    assert oc._load()['generation']==9 and not oc._load()['files'] and not oc._load()['pending']


def test_proxy_only_admits_fixed_review_routes():
    import sys
    sys.path.insert(0,str(ROOT/'hive'))
    from core.code import PROXY_ROUTES
    def allowed(method,path): return any(m==method and re.fullmatch(p,path) for m,p,_ in PROXY_ROUTES)
    prefix='/v1/workspaces/ws_one/reviews/review_one'
    assert allowed('POST',prefix+'/apply')
    assert allowed('GET',prefix+'/hunks/h_'+'a'*64)
    assert allowed('GET','/v1/workspaces/ws_one/git/context')
    assert not allowed('POST','/v1/workspaces/ws_one/git/checkout')
    assert not allowed('GET',prefix+'/hunks/../../files')
    assert not allowed('POST',prefix+'/hunks/h_'+'a'*64)


def test_code_select_needs_approval_by_default():
    from hive.core.policy import DEFAULT_ASK, _matches
    assert any(_matches(p, "code-select") for p in DEFAULT_ASK)


def test_git_export_pending_approval_keeps_exact_observed_source(membrane):
    client,calls=membrane
    client.result={'ok':False,'http_status':403,'result':{'error':'approval_required','details':{'approval_id':'p_export'}}}
    assert 'APPROVAL-NEEDED p_export' in oc.git_export('review/native','Review saved source')
    original=calls[-1][1]
    state=oc._load();state['generation']=8;state['tree_digest']='tree8';oc._save(state)
    client.result={'ok':True,'result':{'id':'gx_one','commit':'commit','bundle_digest':'bundle','patch_digest':'patch'}}
    assert oc.git_export('review/native','Review saved source').startswith('CODE-GIT-EXPORT ')
    assert calls[-1][1]==original|{'approval_id':'p_export'}
    assert original['expected_generation']==7 and oc._load()['generation']==8
    assert oc._load()['files']['x']['digest']=='old'
    assert oc._load()['last_git_export']=='gx_one' and not oc._load()['pending']
    before=oc._state_path().read_bytes()
    oc.git_export_patch('gx_one','1024')
    assert calls[-1]==('git-export-patch',{'workspace_id':'ws_one','export_id':'gx_one','after':1024,'limit':1024})
    assert oc._state_path().read_bytes()==before


def test_original_export_pending_is_mode_isolated_and_preserves_approved_source(membrane):
    client,calls=membrane
    client.result={'ok':False,'http_status':403,'result':{'error':'approval_required','details':{'approval_id':'p_original'}}}
    assert 'APPROVAL-NEEDED p_original' in oc.git_original_export('review/native','Original source')
    original=calls[-1][1]
    assert original['history_mode']=='original'
    state=oc._load();state['generation']=9;state['tree_digest']='later';oc._save(state)
    client.result={'ok':True,'result':{'id':'gx_snapshot','history_kind':'reconstructed-manifest-snapshots'}}
    assert oc.git_export('review/native','Original source').startswith('CODE-GIT-EXPORT ')
    snapshot=calls[-1][1]
    assert 'history_mode' not in snapshot and 'approval_id' not in snapshot
    assert snapshot['operation_id']!=original['operation_id']
    client.result={'ok':True,'result':{'id':'gx_original','history_kind':'original-parent-ancestry','baseline_commit':'parent','source_base_commit':'parent'}}
    assert oc.git_original_export('review/native','Original source').startswith('CODE-GIT-EXPORT ')
    assert calls[-1][1]==original|{'approval_id':'p_original'}
    assert oc._load()['generation']==9 and oc._load()['tree_digest']=='later'


def test_git_export_requires_default_approval_and_only_fixed_proxy_routes():
    from hive.core.policy import Policy
    from hive.core.code import PROXY_ROUTES
    policy=Policy.__new__(Policy);policy.all_rules=lambda:[]
    assert policy.decide({'id':'a_one'},'code-git-export')[0]=='ask'
    assert policy.decide({'id':'a_one'},'code-git-original-export')[0]=='ask'
    assert policy.decide({'id':'a_one'},'code-git-export-state')[0]=='allow'
    assert policy.decide({'id':'a_one'},'code-git-patch')[0]=='allow'
    def allowed(method,path):return any(m==method and re.fullmatch(p,path) for m,p,_ in PROXY_ROUTES)
    prefix='/v1/workspaces/ws_one/git/exports'
    assert allowed('POST',prefix) and allowed('GET',prefix+'/gx_one/patch')
    assert not allowed('POST',prefix+'/gx_one/push')
    assert not allowed('GET',prefix+'/../../operator/grants')
    assert not allowed('DELETE',prefix+'/gx_one')


def test_merge_preview_keeps_ordinary_file_reads_and_bounded_pages(membrane):
    client,calls=membrane
    client.result={'ok':True,'result':{'id':'merge_one','generation':7,'tree_digest':'tree7'}}
    assert oc.merge_create('cp_base','cp_incoming').startswith('CODE-MERGE ')
    assert calls[-1][1]['base_checkpoint_id']=='cp_base'
    assert oc._load()['files']['x']['digest']=='old'
    client.result={'ok':True,'result':{'generation':7,'tree_digest':'tree7','files':[]}}
    oc.merge_files('merge_one','5')
    assert calls[-1]==('merge-state',{'workspace_id':'ws_one','preview_id':'merge_one','after':5,'limit':5})
    before=oc._state_path().read_bytes()
    oc.merge_bytes('merge_one','x','base','0')
    assert calls[-1]==('merge-content',{'workspace_id':'ws_one','preview_id':'merge_one','path':'x','side':'base','after':0,'limit':1024})
    assert oc._state_path().read_bytes()==before
    assert oc.merge_bytes('merge_one','x','base','-1').startswith('CODE-ERROR')


def test_merge_apply_retries_exact_choices_and_does_not_downgrade_current_state(membrane):
    client,calls=membrane
    client.result={'ok':True,'result':{'id':'merge_one','generation':7,'tree_digest':'tree7'}}
    oc.merge_create('cp_base','cp_incoming')
    client.result={'ok':False,'http_status':403,'result':{'error':'approval_required','details':{'approval_id':'p_merge'}}}
    choices='[{"path":"x","choice":"incoming"}]'
    assert 'APPROVAL-NEEDED p_merge' in oc.merge_apply('merge_one',choices)
    original=calls[-1][1]
    state=oc._load();state['generation']=10;state['tree_digest']='tree10';oc._save(state)
    client.result={'ok':True,'result':{'workspace':{'id':'ws_one','generation':8,'tree_digest':'tree8'},'change':{'id':'cs_merge','paths':['x']},'no_change':False}}
    assert oc.merge_apply('merge_one',choices).startswith('CODE-MERGED ')
    assert calls[-1][1]==original|{'approval_id':'p_merge'}
    assert original['expected_generation']==7 and oc._load()['generation']==10
    assert not oc._load()['files'] and not oc._load()['pending']
    assert oc.merge_apply('unknown','[]').startswith('CODE-ERROR')
    assert oc.merge_apply('merge_one','{}').startswith('CODE-ERROR')


def test_merge_apply_asks_by_default_and_proxy_has_no_repository_mutation_route():
    from hive.core.policy import Policy
    from hive.core.code import PROXY_ROUTES
    policy=Policy.__new__(Policy);policy.all_rules=lambda:[]
    assert policy.decide({'id':'a_one'},'code-merge-apply')[0]=='ask'
    assert policy.decide({'id':'a_one'},'code-merge-preview')[0]=='allow'
    def allowed(method,path):return any(m==method and re.fullmatch(p,path) for m,p,_ in PROXY_ROUTES)
    root='/v1/workspaces/ws_one/merges'
    assert allowed('POST',root) and allowed('GET',root+'/merge_one/content') and allowed('POST',root+'/merge_one/apply')
    assert not allowed('GET',root+'/../../operator/grants')
    assert not allowed('POST',root+'/merge_one/commit') and not allowed('DELETE',root+'/merge_one')
