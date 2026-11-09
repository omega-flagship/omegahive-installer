"""Proposed native skill -> actual reviewed client fake-wire tests; no host/model claims."""
import importlib.util,json,pathlib,sys
import httpx,pytest
MODULE=pathlib.Path(__file__).resolve().parents[2]/'modules/code'
spec=importlib.util.spec_from_file_location('native_mind_candidate',MODULE/'src/omega_code.py');oc=importlib.util.module_from_spec(spec);spec.loader.exec_module(oc)
MindControlClient=oc._MIND_SDK.MindControlClient
SPAWN=dict(operation_id='spawn:req:001',request_id='rq_one',team_id='s_one',template_id='tpl_native',initial_prompt='Build Ω; literal _newline_ then \nnew line.',allocation_usd=.5)
def child():return dict(child_id='a_one',controller_id='a_controller',request_id='rq_one',team_id='s_one',template_id='tpl_native',model_id='provider/model',lifecycle_mode='deliver',lifecycle_limits=None,state='unknown',paused_reason=None,recovery_needed=False,prompt_rev=2,prompts=[dict(rev=2,delivery='delivered',interrupted=True)],controls=[],reservation=dict(reservation_id='res_one',allocated_usd=.5,spent_usd=.1,remaining_usd=.4),progress=dict(last_turn_at=None,results=[]))
@pytest.fixture
def wire(monkeypatch,tmp_path):
 monkeypatch.setenv('OMEGACLAW_MEMORY_DIR',str(tmp_path));monkeypatch.setenv('HIVE_API_URL','http://invented.invalid');monkeypatch.setenv('HIVE_WS_TOKEN','invented-token')
 seen=[];answers=[]
 def host(r):
  seen.append(r);answer=answers.pop(0)
  if isinstance(answer,Exception):raise answer
  return answer
 monkeypatch.setattr(oc,'_mind_client',lambda:(MindControlClient('http://invented.invalid','invented-token',transport=httpx.MockTransport(host)),None))
 return seen,answers,tmp_path

def unpack(out):assert oc.decode(out).startswith('CODE-MIND ');return json.loads(oc.decode(out).split(' ',1)[1])
def spawned():return httpx.Response(201,json=dict(child_id='a_one',team_id='s_one',request_id='rq_one',template_id='tpl_native',model_id='provider/model',reservation_id='res_one',prompt_rev=1,state='starting'))
def test_spawn_exact_unicode_and_literal_codec_no_workspace_state(wire):
 seen,answers,tmp=wire;answers.append(spawned());result=unpack(oc.mind_spawn(oc.encode(json.dumps(SPAWN,ensure_ascii=False))))
 assert result['state']=='starting';assert json.loads(seen[0].content)['initial_prompt']==SPAWN['initial_prompt'];assert not (tmp/'omegahive-code.json').exists();assert (tmp/'omegacode-mind-requests.json').exists();assert seen[0].headers['authorization']=='Bearer invented-token'

def test_loss_requires_explicit_exact_retry_no_automatic_retry(wire):
 seen,answers,_=wire;answers.append(httpx.ReadTimeout('invented secret diagnostic'));payload=json.dumps(SPAWN)
 out=oc.mind_spawn(payload);assert out.startswith('CODE-MIND-UNCONFIRMED');assert 'invented secret' not in out;assert len(seen)==1
 answers.append(spawned());assert unpack(oc.mind_spawn(payload))['child_id']=='a_one';assert seen[0].content==seen[1].content

def test_prompt_acceptance_and_control_observation_remain_distinct(wire):
 seen,answers,_=wire;answers.extend([httpx.Response(202,json={'prompt_rev':3,'delivery':'accepted'}),httpx.Response(202,json={'action':'stop','requested_at':'now','observed':None})])
 assert unpack(oc.mind_prompt('a_one',json.dumps(dict(operation_id='prompt:001',text='Continue Ω;',mode='queued',expected_rev=2))))['delivery']=='accepted'
 assert unpack(oc.mind_control('a_one','control:001','stop'))['observed'] is None
 assert [(r.method,r.url.path) for r in seen]==[('POST','/api/agent/minds/a_one/prompt'),('POST','/api/agent/minds/a_one/control')]

@pytest.mark.parametrize('action',['interrupt','stop','pause','resume','retire'])
def test_all_controls_explicit_operation_id(wire,action):
 seen,answers,_=wire;answers.append(httpx.Response(202,json={'action':action,'requested_at':'now','observed':None}));assert unpack(oc.mind_control('a_one','control:001',action))['action']==action;assert json.loads(seen[0].content)=={'operation_id':'control:001','action':action}

def test_unknown_exact_child_and_partial_scan_no_replacement(wire):
 seen,answers,_=wire;answers.extend([httpx.Response(200,json={'children':[child()],'snapshot_at':'first','next_cursor':None}),httpx.Response(200,json={'children':[child()],'snapshot_at':'second','next_cursor':'opaque/Ω'})])
 assert unpack(oc.mind_status('a_one','s_one','a_controller'))['children'][0]['state']=='unknown'
 scan=unpack(oc.mind_scan('s_one','a_controller','1'));assert scan['complete'] is False and scan['next_cursor']=='opaque/Ω';assert scan['recovery_child_ids']==['a_one'];assert all(r.method=='GET' for r in seen)

@pytest.mark.parametrize('field,value',[('team_id','foreign'),('controller_id','foreign')])
def test_child_mismatches_withheld(wire,field,value):
 _,answers,_=wire;data=child();data[field]=value;answers.append(httpx.Response(200,json={'children':[data],'snapshot_at':'now','next_cursor':None}));assert oc.mind_status('a_one','s_one','a_controller').startswith('CODE-MIND-UNCONFIRMED')

@pytest.mark.parametrize('payload',['[]','null','{','{"operation_id":"first","operation_id":"second"}',json.dumps({**SPAWN,'allocation_usd':True}),json.dumps({**SPAWN,'operation_id':'tiny'}),json.dumps({**SPAWN,'unexpected':'field'}),'x'*65537])
def test_invalid_spawn_before_wire(wire,payload):
 seen,_,_=wire;assert oc.mind_spawn(payload).startswith('CODE-MIND-INVALID');assert not seen

@pytest.mark.parametrize('pages',['0','101','-1','1.5','true','١',''])
def test_invalid_scan_before_wire(wire,pages):
 seen,_,_=wire;assert oc.mind_scan('s_one','a_controller',pages).startswith('CODE-MIND-INVALID');assert not seen

@pytest.mark.parametrize('status,code',[(403,'lease_expired'),(409,'operation_conflict'),(429,'budget_exhausted')])
def test_host_refusal_has_no_retry_or_secret_echo(wire,status,code):
 seen,answers,_=wire;answers.append(httpx.Response(status,json={'error':{'code':code,'message':'invented secret never echoed'}}));out=oc.mind_control('a_one','control:001','resume');assert oc.decode(out)==f'CODE-MIND-REFUSED {status} {code}';assert len(seen)==1

def test_unusable_stop_response_never_observed_success(wire):
 _,answers,_=wire;answers.append(httpx.Response(202,json={'action':'stop','requested_at':'now','observed':'stopped'}));assert oc.mind_control('a_one','control:001','stop').startswith('CODE-MIND-UNCONFIRMED')

def test_templates_exact_choices(wire):
 seen,answers,_=wire;answers.append(httpx.Response(200,json={'templates':[{'template_id':'native','harness':'native','model_id':'provider/model','role_id':'coder','max_allocation_usd':1,'controls':['stop'],'lifecycle_modes':['deliver'],'overridable':{'model_id':[]}}]}));assert unpack(oc.mind_templates('s_one'))['templates'][0]['harness']=='native';assert seen[0].url.params['team_id']=='s_one'

def test_exact_request_is_fsynced_before_wire(wire,monkeypatch):
 seen,answers,tmp=wire
 def before(r):
  data=json.loads((tmp/'omegacode-mind-requests.json').read_text());record=next(iter(data['requests'].values()));assert record['intent']['body']==json.loads(r.content);assert not (tmp/'omegacode-mind-requests.json').stat().st_mode&0o077;return spawned()
 monkeypatch.setattr(oc,'_mind_client',lambda:(MindControlClient('http://invented.invalid','invented-token',transport=httpx.MockTransport(before)),None))
 assert unpack(oc.mind_spawn(json.dumps(SPAWN)))['child_id']=='a_one';assert 'invented-token' not in (tmp/'omegacode-mind-requests.json').read_text()

def test_reload_recovers_original_payload_and_retains_unknown_admission(wire):
 seen,answers,tmp=wire;answers.append(httpx.ReadTimeout('lost response'))
 assert oc.mind_spawn(json.dumps(SPAWN)).startswith('CODE-MIND-UNCONFIRMED')
 spec=importlib.util.spec_from_file_location('reloaded_native_mind',MODULE/'src/omega_code.py');fresh=importlib.util.module_from_spec(spec);spec.loader.exec_module(fresh);fresh._mind_client=oc._mind_client
 data=json.loads((tmp/'omegacode-mind-requests.json').read_text());saved=next(iter(data['requests'].values()))['intent'];assert 'state' not in saved
 answers.append(spawned());assert unpack(fresh.mind_spawn(json.dumps(saved['body'])))['child_id']=='a_one';assert seen[0].content==seen[1].content;assert len(data['requests'])==1

@pytest.mark.parametrize('change',[{'initial_prompt':'different'},{'allocation_usd':1},{'team_id':'foreign'}])
def test_same_operation_changed_payload_refuses_before_second_wire(wire,change):
 seen,answers,_=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));out=oc.mind_spawn(json.dumps({**SPAWN,**change}));assert oc.decode(out)=='CODE-MIND-JOURNAL-REFUSED operation_changed; retain original operation_id and exact payload; do not rekey';assert len(seen)==1

def test_same_operation_different_route_refuses(wire):
 seen,answers,_=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));assert oc.decode(oc.mind_control('a_one',SPAWN['operation_id'],'stop'))=='CODE-MIND-JOURNAL-REFUSED operation_changed; retain original operation_id and exact payload; do not rekey';assert len(seen)==1

@pytest.mark.parametrize('damage',['syntax','digest','duplicate','permissions','symlink'])
def test_damaged_journal_never_forgets_intent_or_sends_write(wire,damage):
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));journal=tmp/'omegacode-mind-requests.json'
 if damage=='syntax':journal.write_text('{')
 elif damage=='duplicate':journal.write_text('{"schema":1,"schema":1,"requests":{}}')
 elif damage=='permissions':journal.chmod(0o644)
 elif damage=='symlink':journal.rename(tmp/'retained.json');journal.symlink_to(tmp/'retained.json')
 else:
  data=json.loads(journal.read_text());next(iter(data['requests'].values()))['digest']='altered';journal.write_text(json.dumps(data))
 expected='CODE-MIND-UNAVAILABLE' if damage=='symlink' else 'CODE-MIND-JOURNAL-REFUSED'
 assert oc.mind_spawn(json.dumps(SPAWN)).startswith(expected);assert len(seen)==1

def test_missing_memory_refuses_only_writes(wire,monkeypatch):
 seen,answers,_=wire;monkeypatch.delenv('OMEGACLAW_MEMORY_DIR');assert oc.decode(oc.mind_spawn(json.dumps(SPAWN)))=='CODE-MIND-JOURNAL-REFUSED memory_required; retain original operation_id and exact payload; do not rekey';assert not seen
 answers.append(httpx.Response(200,json={'children':[child()],'snapshot_at':'read','next_cursor':None}));assert unpack(oc.mind_status('a_one','s_one','a_controller'))['children'][0]['state']=='unknown';assert len(seen)==1

@pytest.mark.parametrize('kind',['origin','reader'])
def test_namespaced_operation_does_not_merge_other_hive_or_reader(wire,monkeypatch,kind):
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN))
 def host(r):seen.append(r);return spawned()
 monkeypatch.setattr(oc,'_mind_client',lambda:(MindControlClient('http://other.invalid' if kind=='origin' else 'http://invented.invalid','different-token' if kind=='reader' else 'invented-token',transport=httpx.MockTransport(host)),None))
 assert unpack(oc.mind_spawn(json.dumps({**SPAWN,'initial_prompt':'new scope'})))['state']=='starting'
 assert len(json.loads((tmp/'omegacode-mind-requests.json').read_text())['requests'])==2

def test_private_journal_does_not_change_workspace_state(wire):
 _,answers,tmp=wire;workspace=tmp/'omegahive-code.json';workspace.write_text('{"goal":"untouched","pending":{"original":true}}');old=workspace.read_bytes();answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));assert workspace.read_bytes()==old

@pytest.mark.parametrize('different',[False,True])
def test_concurrent_processes_preserve_one_exact_operation(tmp_path,different):
 import subprocess,os
 program='''import importlib.util,sys,json
s=importlib.util.spec_from_file_location('candidate',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
MindControlClient=m._MIND_SDK.MindControlClient
with MindControlClient('http://invented.invalid','invented-token') as c:
 try:m._retain_mind_write(c,'POST','/api/agent/minds',m._MIND_SDK._spawn_body(**json.loads(sys.argv[2])),m._MIND_SDK._write_contract('spawn'));print('retained')
 except m._MindJournalError as e:print(e.code)
'''
 env={**os.environ,'OMEGACLAW_MEMORY_DIR':str(tmp_path),'PYTHONDONTWRITEBYTECODE':'1'}
 second={**SPAWN,'initial_prompt':'different'} if different else SPAWN
 jobs=[subprocess.Popen([sys.executable,'-c',program,str(MODULE/'src/omega_code.py'),json.dumps(body)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for body in (SPAWN,second)]
 outputs=[]
 for job in jobs:
  out,err=job.communicate(timeout=20);assert job.returncode==0,err;outputs.append(out.strip())
 assert sorted(outputs)==(['operation_changed','retained'] if different else ['retained','retained']);data=json.loads((tmp_path/'omegacode-mind-requests.json').read_text());assert len(data['requests'])==1;assert not list(tmp_path.glob('.mind-request-*'))

def test_full_journal_keeps_exact_retry_but_refuses_new_operation(wire):
 import hashlib
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));journal=tmp/'omegacode-mind-requests.json';data=json.loads(journal.read_text());sample=next(iter(data['requests'].values()))['intent']
 for i in range(999):
  saved=json.loads(json.dumps(sample));saved['operation_id']=f'old:operation:{i:04d}';saved['body']['operation_id']=saved['operation_id'];key=hashlib.sha256(oc._mind_canonical([saved['scope'],saved['operation_id']]).encode()).hexdigest();data['requests'][key]={'intent':saved,'digest':hashlib.sha256(oc._mind_canonical(saved).encode()).hexdigest()}
 journal.write_text(oc._mind_canonical(data));answers.append(spawned());assert unpack(oc.mind_spawn(json.dumps(SPAWN)))['child_id']=='a_one';assert len(seen)==2
 assert oc.decode(oc.mind_spawn(json.dumps({**SPAWN,'operation_id':'new:operation:001'})))=='CODE-MIND-JOURNAL-REFUSED journal_capacity; retain original operation_id and exact payload; do not rekey';assert len(seen)==2;assert len(json.loads(journal.read_text())['requests'])==1000

@pytest.mark.parametrize('extra',[float('nan'),float('inf')])
def test_post_dispatch_nonfinite_response_is_unconfirmed_with_retained_intent(wire,extra):
 seen,answers,tmp=wire;data=spawned().json();data['additional_nonfinite']=extra;answers.append(httpx.Response(201,text=json.dumps(data)))
 out=oc.mind_spawn(json.dumps(SPAWN));assert out.startswith('CODE-MIND-UNCONFIRMED');assert 'original operation_id' in out;assert len(seen)==1;assert len(json.loads((tmp/'omegacode-mind-requests.json').read_text())['requests'])==1

def test_post_dispatch_value_error_is_unconfirmed(wire,monkeypatch):
 seen,_,tmp=wire
 def broken(r):seen.append(r);raise ValueError('invented private transport detail')
 monkeypatch.setattr(oc,'_mind_client',lambda:(MindControlClient('http://invented.invalid','invented-token',transport=httpx.MockTransport(broken)),None))
 out=oc.mind_spawn(json.dumps(SPAWN));assert out.startswith('CODE-MIND-UNCONFIRMED');assert 'private transport' not in out;assert len(seen)==1;assert (tmp/'omegacode-mind-requests.json').exists()

def test_local_inspection_recovers_exact_payload_without_network_or_admission(wire):
 seen,answers,tmp=wire;answers.append(httpx.ReadTimeout('lost'));oc.mind_spawn(json.dumps(SPAWN));before=(tmp/'omegacode-mind-requests.json').read_bytes()
 result=unpack(oc.mind_request(SPAWN['operation_id']));assert result['source']=='local_retained_request' and result['host_admission']=='not_established';assert result['body']['initial_prompt']==SPAWN['initial_prompt'];assert len(seen)==1;assert (tmp/'omegacode-mind-requests.json').read_bytes()==before;assert 'invented-token' not in json.dumps(result)

def test_explicit_retry_after_reload_uses_retained_request_and_host(wire):
 seen,answers,_=wire;answers.append(httpx.ReadTimeout('lost'));oc.mind_spawn(json.dumps(SPAWN))
 s=importlib.util.spec_from_file_location('fresh_recovery',MODULE/'src/omega_code.py');fresh=importlib.util.module_from_spec(s);s.loader.exec_module(fresh);fresh._mind_client=oc._mind_client
 answers.append(spawned());assert unpack(fresh.mind_retry(SPAWN['operation_id']))['child_id']=='a_one';assert seen[0].content==seen[1].content;assert len(seen)==2

@pytest.mark.parametrize('kind',['prompt','control'])
def test_explicit_prompt_control_retries_keep_original_path_body_and_outcome(wire,kind):
 seen,answers,_=wire;answers.append(httpx.ReadTimeout('lost'))
 if kind=='prompt':
  op='prompt:001';oc.mind_prompt('a_one',json.dumps(dict(operation_id=op,text='Continue Ω;',mode='queued',expected_rev=2)));answer=httpx.Response(202,json={'prompt_rev':3,'delivery':'accepted'})
 else:
  op='control:001';oc.mind_control('a_one',op,'stop');answer=httpx.Response(202,json={'action':'stop','requested_at':'original','observed':None})
 answers.append(answer);out=unpack(oc.mind_retry(op));assert seen[0].url.path==seen[1].url.path and seen[0].content==seen[1].content
 assert out['delivery']=='accepted' if kind=='prompt' else out['observed'] is None

@pytest.mark.parametrize('kind',['origin','reader'])
def test_current_scope_cannot_inspect_or_retry_another_scope(wire,monkeypatch,kind):
 seen,answers,_=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));monkeypatch.setattr(oc,'_mind_client',lambda:(MindControlClient('http://other.invalid' if kind=='origin' else 'http://invented.invalid','different-token' if kind=='reader' else 'invented-token'),None))
 assert oc.decode(oc.mind_request(SPAWN['operation_id']))=='CODE-MIND-JOURNAL-REFUSED request_not_retained; retain original operation_id and exact payload; do not rekey';assert oc.decode(oc.mind_retry(SPAWN['operation_id']))=='CODE-MIND-JOURNAL-REFUSED request_not_retained; retain original operation_id and exact payload; do not rekey';assert len(seen)==1

@pytest.mark.parametrize('command',['mind_request','mind_retry'])
def test_unknown_request_has_no_fallback_or_network(wire,command):
 seen,_,tmp=wire;out=getattr(oc,command)('unknown:operation');assert out.startswith('CODE-MIND-UNAVAILABLE') and 'do not rekey' in out and 'request_not_retained' not in out;assert not seen;assert not list(tmp.iterdir())

@pytest.mark.parametrize('damage',['syntax','digest','permissions','symlink'])
def test_recovery_reuses_strict_retention_validation(wire,damage):
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));p=tmp/'omegacode-mind-requests.json'
 if damage=='syntax':p.write_text('{')
 elif damage=='permissions':p.chmod(0o644)
 elif damage=='symlink':p.rename(tmp/'retained.json');p.symlink_to(tmp/'retained.json')
 else:
  data=json.loads(p.read_text());next(iter(data['requests'].values()))['digest']='altered';p.write_text(json.dumps(data))
 expected='CODE-MIND-UNAVAILABLE' if damage=='symlink' else 'CODE-MIND-JOURNAL-REFUSED'
 assert oc.mind_request(SPAWN['operation_id']).startswith(expected);assert oc.mind_retry(SPAWN['operation_id']).startswith(expected);assert len(seen)==1


def test_host_refusal_on_explicit_retry_remains_authoritative(wire):
 seen,answers,_=wire;answers.append(httpx.ReadTimeout('lost'));oc.mind_spawn(json.dumps(SPAWN));answers.append(httpx.Response(403,json={'error':{'code':'request_cancelled','message':'synthetic'}}));assert oc.mind_retry(SPAWN['operation_id'])=='CODE-MIND-REFUSED 403 request_cancelled';assert len(seen)==2

@pytest.mark.parametrize('literal',['_quote_','_newline_'])
def test_literal_operation_id_survives_inspection_and_explicit_retry(wire,literal):
 seen,answers,_=wire;body={**SPAWN,'operation_id':'spawn:'+literal+':001'};answers.extend([spawned(),spawned()]);assert unpack(oc.mind_spawn(json.dumps(body)))['state']=='starting';assert unpack(oc.mind_request(body['operation_id']))['body']['operation_id']==body['operation_id'];assert unpack(oc.mind_retry(body['operation_id']))['child_id']=='a_one';assert len(seen)==2 and seen[0].content==seen[1].content

@pytest.mark.parametrize('literal',['_quote_','_newline_'])
def test_literal_control_operation_and_child_id_survive(wire,literal):
 seen,answers,_=wire;ident='child'+literal;op='control:'+literal+':001';answers.extend([httpx.Response(202,json={'action':'stop','requested_at':'now','observed':None})]*2)
 assert unpack(oc.mind_control(ident,op,'stop'))['observed'] is None;assert unpack(oc.mind_request(op))['body']['operation_id']==op;assert unpack(oc.mind_retry(op))['observed'] is None;assert seen[0].url.path=='/api/agent/minds/'+ident+'/control';assert seen[0].content==seen[1].content

@pytest.mark.parametrize('literal',['_quote_','_newline_'])
def test_literal_team_and_controller_ids_survive_status_scan_templates(wire,literal):
 seen,answers,_=wire;data=child();data.update(child_id='child'+literal,team_id='team'+literal,controller_id='controller'+literal);page={'children':[data],'snapshot_at':'now','next_cursor':None};answers.extend([httpx.Response(200,json=page),httpx.Response(200,json=page),httpx.Response(200,json={'templates':[]})])
 assert unpack(oc.mind_status(data['child_id'],data['team_id'],data['controller_id']))['children'][0]['child_id']==data['child_id'];assert unpack(oc.mind_scan(data['team_id'],data['controller_id'],'1'))['team_id']==data['team_id'];assert unpack(oc.mind_templates(data['team_id']))['templates']==[];assert seen[0].url.params['child_id']==data['child_id'];assert seen[1].url.params['team_id']==data['team_id'];assert seen[2].url.params['team_id']==data['team_id']

@pytest.mark.parametrize('literal',['_quote_','_newline_'])
def test_literal_prompt_child_reference_survives(wire,literal):
 seen,answers,_=wire;answers.append(httpx.Response(202,json={'prompt_rev':3,'delivery':'accepted'}));ident='child'+literal;assert unpack(oc.mind_prompt(ident,json.dumps(dict(operation_id='prompt:001',text='Exact',mode='queued',expected_rev=2))))['delivery']=='accepted';assert seen[0].url.path=='/api/agent/minds/'+ident+'/prompt'

def work_request():return dict(id='rq_quote_',receiving_goal='g_one',to_swarm='team_newline_',state='cancelled',budget=dict(root='root_one',limit_usd=2,allocated_usd=.5),context_refs={'instruction':'synthetic preserved text'})

def test_host_work_request_keeps_goal_state_budget_context_without_journal_or_admission(wire):
 seen,answers,tmp=wire;data=work_request();answers.append(httpx.Response(200,json=data));out=unpack(oc.mind_work(data['id'],data['to_swarm']));assert out=={'source':'host_work_request','request':data};assert seen[0].method=='GET' and seen[0].url.path=='/api/agent/requests/rq_quote_';assert not list(tmp.iterdir())

@pytest.mark.parametrize('field,value',[('id','other_request'),('to_swarm','other_team')])
def test_host_work_identity_refusal(wire,field,value):
 seen,answers,_=wire;data=work_request();data[field]=value;answers.append(httpx.Response(200,json=data));assert oc.mind_work('rq_quote_','team_newline_').startswith('CODE-MIND-UNCONFIRMED');assert len(seen)==1


def test_host_work_outsider_refusal(wire):
 seen,answers,_=wire;answers.append(httpx.Response(403,json={'error':{'code':'forbidden','message':'private request details'}}));assert oc.mind_work('rq_quote_','team_newline_')=='CODE-MIND-REFUSED 403 forbidden';assert len(seen)==1


def test_host_work_new_read_does_not_reuse_previous_request(wire):
 seen,answers,_=wire;data=work_request();answers.extend([httpx.Response(200,json=data),httpx.Response(403,json={'error':{'code':'forbidden','message':'request withdrawn'}})]);assert unpack(oc.mind_work(data['id'],data['to_swarm']))['request']['state']=='cancelled';assert oc.mind_work(data['id'],data['to_swarm'])=='CODE-MIND-REFUSED 403 forbidden';assert len(seen)==2


# Current97 boundaries: actual imported SDK client and actual forwardported module.
def test_selected_current97_derived_module_local_client_Source_identity():
 import hashlib
 actual=oc._MIND_SDK
 assert pathlib.Path(actual.__file__).resolve()==MODULE/'src/mind_control_client.py'
 assert hashlib.sha256(pathlib.Path(actual.__file__).read_bytes()).hexdigest() == 'b24162a4693501baf823a0aa318ff5410e4d563380d22b23e020c59412a15079'
 assert actual.MindControlClient is MindControlClient
 assert oc._MIND_CLIENT_SHA256 == 'b24162a4693501baf823a0aa318ff5410e4d563380d22b23e020c59412a15079'

@pytest.mark.parametrize('role,accepted',[(None,True),('',False),(7,False)])
def test_current97_nullable_template_role_and_malformed_roles(wire,role,accepted):
 seen,answers,tmp=wire
 template=dict(template_id='native',harness='native',model_id='provider/model',role_id=role,max_allocation_usd=.25,controls=['stop','retire'],lifecycle_modes=['bounded'],overridable={'model_id':[]})
 answers.append(httpx.Response(200,json={'templates':[template]}))
 result=oc.mind_templates('s_one')
 if accepted: assert unpack(result)['templates'][0]['role_id'] is None
 else: assert result.startswith('CODE-MIND-UNCONFIRMED')
 assert len(seen)==1 and seen[0].method=='GET' and seen[0].url.path=='/api/agent/minds/templates'
 assert not list(tmp.iterdir())

@pytest.mark.parametrize('action',['spawn','prompt'])
@pytest.mark.parametrize('shape,valid',[('ascii8192',True),('ascii8193',False),('utf8_8192',True),('utf8_8193',False)])
def test_current97_prompt_cap_is_original_UTF8_bytes_before_wire(wire,action,shape,valid):
 seen,answers,tmp=wire
 text=('x'*8192 if shape=='ascii8192' else 'x'*8193 if shape=='ascii8193' else chr(0x1f600)*2048 if shape=='utf8_8192' else chr(0x1f600)*2048+'x')
 assert len(text.encode('utf-8'))==(8192 if valid else 8193)
 if action=='spawn':
  body={**SPAWN,'initial_prompt':text}
  if valid: answers.append(spawned())
  result=oc.mind_spawn(oc.encode(json.dumps(body,ensure_ascii=False)));field='initial_prompt'
 else:
  body=dict(operation_id='prompt:boundary:001',text=text,mode='queued',expected_rev=2)
  if valid: answers.append(httpx.Response(202,json={'prompt_rev':3,'delivery':'accepted'}))
  result=oc.mind_prompt('a_one',oc.encode(json.dumps(body,ensure_ascii=False)));field='text'
 if valid:
  unpack(result);assert len(seen)==1 and json.loads(seen[0].content)[field]==text
 else:
  assert result.startswith('CODE-MIND-INVALID') and not seen and not list(tmp.iterdir())



# R2 regressions exercise the shipped client/gate and the real journal/recovery methods.
def _fixture_module(tmp_path, vendor):
 target=tmp_path/'module';target.mkdir()
 helper=target/'omega_code.py';helper.write_bytes((MODULE/'src/omega_code.py').read_bytes())
 if vendor is not None:(target/'mind_control_client.py').write_bytes(vendor)
 spec=importlib.util.spec_from_file_location('fixture_native_mind_binding',helper)
 module=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(module)
 return module


@pytest.mark.parametrize('state',['missing','mismatched'])
def test_startup_refuses_missing_or_mismatched_shipped_client_before_use(tmp_path,state):
 vendor=None if state=='missing' else (MODULE/'src/mind_control_client.py').read_bytes()+b'\nraise AssertionError("unreviewed client executed")\n'
 with pytest.raises(ImportError,match='CODE-MIND-INSTALL-REFUSED'):
  _fixture_module(tmp_path,vendor)


def test_startup_refuses_missing_public_httpx_dependency(tmp_path,monkeypatch):
 import builtins
 original=builtins.__import__
 def unavailable(name,*args,**kwargs):
  if name=='httpx':raise ImportError('invented missing public dependency')
  return original(name,*args,**kwargs)
 with monkeypatch.context() as patch:
  patch.setattr(builtins,'__import__',unavailable)
  with pytest.raises(ImportError,match='CODE-MIND-INSTALL-REFUSED client public dependency unavailable'):
   _fixture_module(tmp_path,(MODULE/'src/mind_control_client.py').read_bytes())


def test_startup_uses_only_local_pinned_client_and_starts_no_http_client(tmp_path,monkeypatch):
 import types
 foreign=types.ModuleType('omegacode.mind_client');foreign.MindControlClient=object()
 with monkeypatch.context() as patch:
  patch.setitem(sys.modules,'omegacode.mind_client',foreign)
  patch.setattr(httpx,'Client',lambda *a,**k:pytest.fail('startup created a transport'))
  fresh=_fixture_module(tmp_path,(MODULE/'src/mind_control_client.py').read_bytes())
 assert fresh._MIND_SDK.MindControlClient is not foreign.MindControlClient
 assert pathlib.Path(fresh._MIND_SDK.__file__).parent==tmp_path/'module'


@pytest.mark.parametrize('command',['mind_request','mind_retry'])
@pytest.mark.parametrize('where',['lock','journal'])
@pytest.mark.parametrize('error_name',['EAGAIN','EMFILE','EIO'])
def test_transient_recovery_io_is_unavailable_never_absence_or_new_write(wire,monkeypatch,command,where,error_name):
 import errno
 seen,answers,tmp=wire;answers.append(httpx.ReadTimeout('lost'));oc.mind_spawn(json.dumps(SPAWN))
 journal=tmp/'omegacode-mind-requests.json';before=journal.read_bytes();original=oc.os.open
 target=str(tmp/('.omegacode-mind-requests.lock' if where=='lock' else 'omegacode-mind-requests.json'))
 def unavailable(path,*args,**kwargs):
  if str(path)==target:raise OSError(getattr(errno,error_name),'invented private I/O detail')
  return original(path,*args,**kwargs)
 with monkeypatch.context() as patch:
  patch.setattr(oc.os,'open',unavailable)
  out=getattr(oc,command)(SPAWN['operation_id'])
 assert out.startswith('CODE-MIND-UNAVAILABLE') and 'do not rekey' in out
 assert 'request_not_retained' not in out and 'private' not in out
 assert journal.read_bytes()==before and len(seen)==1


@pytest.mark.parametrize('command',['mind_request','mind_retry'])
@pytest.mark.parametrize('missing',['lock','journal'])
def test_missing_recovery_file_is_ambiguous_and_keeps_original_key(wire,command,missing):
 seen,answers,tmp=wire;answers.append(httpx.ReadTimeout('lost'));oc.mind_spawn(json.dumps(SPAWN))
 (tmp/('.omegacode-mind-requests.lock' if missing=='lock' else 'omegacode-mind-requests.json')).unlink()
 out=getattr(oc,command)(SPAWN['operation_id'])
 assert out.startswith('CODE-MIND-UNAVAILABLE') and 'retry same key' in out and 'do not rekey' in out
 assert 'request_not_retained' not in out and len(seen)==1


@pytest.mark.parametrize('command',['mind_request','mind_retry'])
def test_complete_valid_journal_can_prove_only_local_key_absence(wire,command):
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN))
 out=getattr(oc,command)('different:operation:001')
 assert oc.decode(out)=='CODE-MIND-JOURNAL-REFUSED request_not_retained; retain original operation_id and exact payload; do not rekey'
 assert len(seen)==1 and (tmp/'omegacode-mind-requests.json').exists()


def _initial_write(kind,wire):
 seen,answers,tmp=wire;answers.append(httpx.ReadTimeout('lost'))
 if kind=='spawn':
  op=SPAWN['operation_id'];oc.mind_spawn(json.dumps(SPAWN));answer=spawned()
 elif kind=='prompt':
  op='prompt:exact:001';oc.mind_prompt('a_one',json.dumps(dict(operation_id=op,text='Exact Ω;',mode='queued',expected_rev=2)));answer=httpx.Response(202,json={'prompt_rev':3,'delivery':'accepted'})
 else:
  op='control:exact:001';oc.mind_control('a_one',op,'stop');answer=httpx.Response(202,json={'action':'stop','requested_at':'original','observed':None})
 return op,answer


@pytest.mark.parametrize('kind',['spawn','prompt','control'])
def test_retry_sends_exact_retained_triple_without_calling_normal_write_methods(wire,monkeypatch,kind):
 seen,answers,tmp=wire;op,answer=_initial_write(kind,wire);first=(seen[0].method,str(seen[0].url),seen[0].content)
 with monkeypatch.context() as patch:
  for name in ['spawn','prompt','control']:
   patch.setattr(MindControlClient,name,lambda *a,**k:pytest.fail('re-dispatched normal write method'))
  answers.append(answer);out=unpack(oc.mind_retry(op))
 assert (seen[1].method,str(seen[1].url),seen[1].content)==first and len(seen)==2
 assert out['state']=='starting' if kind=='spawn' else out['delivery']=='accepted' if kind=='prompt' else out['observed'] is None


@pytest.mark.parametrize('kind',['spawn','prompt','control'])
def test_replay_reuses_original_response_validator(wire,kind):
 seen,answers,tmp=wire;op,answer=_initial_write(kind,wire);body=answer.json()
 if kind=='spawn':body['request_id']='foreign'
 elif kind=='prompt':body['prompt_rev']=2
 else:body['observed']=True
 answers.append(httpx.Response(answer.status_code,json=body))
 out=oc.mind_retry(op)
 assert out.startswith('CODE-MIND-UNCONFIRMED') and len(seen)==2
 assert seen[0].content==seen[1].content


@pytest.mark.parametrize('kind',['spawn','prompt','control'])
def test_replay_keeps_original_status_contract(wire,kind):
 seen,answers,tmp=wire;op,answer=_initial_write(kind,wire)
 answers.append(httpx.Response(202 if kind=='spawn' else 201,json=answer.json()))
 assert oc.mind_retry(op).startswith('CODE-MIND-UNCONFIRMED') and len(seen)==2


@pytest.mark.parametrize('path',['https://foreign.invalid/api/agent/minds','//foreign.invalid/api/agent/minds','/api/agent/minds?extra=1','/api/agent/minds#fragment','/api/agent/../minds','/api/agent/%2e%2e/minds','/api/agent/minds\\foreign'])
def test_even_rehashed_journal_cannot_escape_original_origin_or_contract(wire,path):
 import hashlib
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));journal=tmp/'omegacode-mind-requests.json';data=json.loads(journal.read_text());record=next(iter(data['requests'].values()));record['intent']['path']=path;record['digest']=hashlib.sha256(oc._mind_canonical(record['intent']).encode()).hexdigest();journal.write_text(oc._mind_canonical(data))
 out=oc.mind_retry(SPAWN['operation_id'])
 assert out.startswith('CODE-MIND-JOURNAL-REFUSED journal_corrupt') and 'do not rekey' in out and len(seen)==1


@pytest.mark.parametrize('kind',['prompt','control'])
@pytest.mark.parametrize('child',['.','..'])
def test_initial_write_rejects_dot_path_child_before_retention_or_transport(wire,kind,child):
 seen,answers,tmp=wire
 out=oc.mind_prompt(child,json.dumps(dict(operation_id='prompt:dot:001',text='Exact',mode='queued',expected_rev=1))) if kind=='prompt' else oc.mind_control(child,'control:dot:001','stop')
 assert out.startswith('CODE-MIND-INVALID') and not seen and not list(tmp.iterdir())


def test_legacy_five_field_intent_stays_inspectable_and_requires_explicit_migration(wire):
 import hashlib
 seen,answers,tmp=wire;answers.append(spawned());oc.mind_spawn(json.dumps(SPAWN));journal=tmp/'omegacode-mind-requests.json';data=json.loads(journal.read_text());record=next(iter(data['requests'].values()));del record['intent']['contract'];record['digest']=hashlib.sha256(oc._mind_canonical(record['intent']).encode()).hexdigest();journal.write_text(oc._mind_canonical(data))
 assert unpack(oc.mind_request(SPAWN['operation_id']))['body']['operation_id']==SPAWN['operation_id']
 out=oc.mind_retry(SPAWN['operation_id'])
 assert 'legacy_contract_missing_operator_migration_required' in out and 'do not rekey' in out
 assert 'request_not_retained' not in out and len(seen)==1


def test_before_request_callback_is_explicit_and_restored_without_method_replacement(wire,monkeypatch):
 seen,answers,tmp=wire;client=MindControlClient('http://invented.invalid','invented-token',transport=httpx.MockTransport(lambda r:spawned()));calls=[]
 def callback(method,path,**kw):calls.append((method,path,kw))
 client.before_request=callback;original=client._call.__func__
 monkeypatch.setattr(oc,'_mind_client',lambda:(client,None));answers.clear()
 assert unpack(oc.mind_spawn(json.dumps(SPAWN)))['child_id']=='a_one'
 assert client._call.__func__ is original and client.before_request is callback
 assert calls[0][0:2]==('POST','/api/agent/minds') and calls[0][2]['contract']=={'version':1,'kind':'spawn'}
 assert calls[0][2]['status']==frozenset({201})


def test_spawn_refusal_names_missing_and_unknown_fields(wire):
 # The live controller's payload: template and allocation right, goal_id/prompt instead of initial_prompt, no keys.
 seen,_,_=wire;out=oc.decode(oc.mind_spawn(json.dumps({'template_id':'tpl_native','allocation_usd':.5,'goal_id':'g_work','prompt':'Build it'})))
 assert not seen and out.startswith('CODE-MIND-INVALID spawn payload missing operation_id request_id team_id initial_prompt; unknown goal_id prompt;')
 assert 'name the work goal id inside initial_prompt' in out and 'use initial_prompt not prompt' in out
 assert 'required operation_id request_id team_id template_id initial_prompt allocation_usd' in out
 assert '\n' not in out and not any(ch in out for ch in '"\'()[]{}')

@pytest.mark.parametrize('payload,fragment',[(json.dumps({k:v for k,v in SPAWN.items() if k!='team_id'}),'missing team_id;'),
 (json.dumps({**SPAWN,'unexpected':'field'}),'spawn payload unknown unexpected;'),
 (json.dumps({**SPAWN,'operation_id':'tiny'}),'spawn payload operation_id must match'),
 ('{','spawn payload must be one JSON object')])
def test_spawn_refusal_each_problem_is_named(wire,payload,fragment):
 seen,_,_=wire;out=oc.decode(oc.mind_spawn(payload))
 assert not seen and out.startswith('CODE-MIND-INVALID ') and fragment in out
 assert '\n' not in out and not any(ch in out for ch in '"\'()[]{}')

def test_spawn_card_example_is_a_complete_payload_that_reaches_the_wire(wire):
 import re
 card=(MODULE/'affordance.metta').read_text(encoding='utf-8')
 line=next(l for l in card.splitlines() if l.startswith('(SkillCardLine "code-mind-spawn" "code-mind-spawn example'))
 example=json.loads(re.search(r'(\{\\".*?\})',line).group(1).replace('\\"','"'))
 assert set(oc._SPAWN_REQUIRED)<=set(example) and set(example)<=set(oc._SPAWN_REQUIRED)|set(oc._SPAWN_OPTIONAL)
 assert re.search(r'Work goal (g_\w+)',example['initial_prompt'])
 help_text=(MODULE/'catalog.metta').read_text(encoding='utf-8')
 assert json.dumps(example,separators=(',',':')).replace('"','\\"') in help_text
 seen,answers,_=wire;answers.append(httpx.Response(201,json=dict(child_id='a_one',team_id=example['team_id'],request_id=example['request_id'],template_id=example['template_id'],model_id='provider/model',reservation_id='res_one',prompt_rev=1,state='starting')))
 assert unpack(oc.mind_spawn(json.dumps(example)))['state']=='starting' and json.loads(seen[0].content)['initial_prompt']==example['initial_prompt']
