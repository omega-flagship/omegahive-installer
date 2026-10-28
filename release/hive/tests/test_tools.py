"""Reviewed first slice through the one host sandbox runner; no live mind."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from hive.core.tools import ToolRegistry, clean_selection, digest, run_for_actor
from hive.core import sandbox_run
from hive.core.programs import Programs
from hive.supervisor.workspace import Workspace, RUN_METTA

CORE=Path(__file__).resolve().parents[2]
if not os.environ.get('OMEGA_TOOLS_TEST_PACKAGE') or not os.environ.get('PETTA_PATH'):
    pytest.skip('explicit reviewed pack and PeTTa required', allow_module_level=True)
PACKAGE=Path(os.environ['OMEGA_TOOLS_TEST_PACKAGE'])
PETTA=os.environ['PETTA_PATH']
TOOLS=['omegahive.tools.'+x+'@0.1.0' for x in ('attention','ensemble','predictive_learning')]

@pytest.fixture
def config(monkeypatch):
    pin=digest(PACKAGE/'evidence/all-tools-pack-check.json')
    monkeypatch.setenv('HIVE_SANDBOX_RUN_APPS','omega-tools')
    monkeypatch.setenv('HIVE_SANDBOX_RUNTIMES',json.dumps({'metta':{'exe':sys.executable,'reads':[sys.prefix,PETTA]}}))
    return pin

def admitted_programs():
    # Unit adapter fixture only. Actual Programs admission is covered by the
    # authenticated API suite, including disable/reload/tampering.
    return SimpleNamespace(pinned_release=lambda pid: {'path':str(PACKAGE),
                           'digest':Programs.source_digest(PACKAGE), 'version':'0.6.1',
                           'files':{'release-data.lock.json':digest(PACKAGE/'release-data.lock.json')}} if pid=='omega-tools' else None)

@pytest.fixture
def ctx(config):
    settings=SimpleNamespace(core_root=CORE,petta_path=PETTA,offline=True,default_driver='local')
    agent={'id':'synthetic','swarm_id':'swarm','kind':'omega','model':'mock/echo','driver':'local','options':{'tools':TOOLS}}
    hive=SimpleNamespace(settings=settings,agent=lambda aid:agent,programs=admitted_programs())
    def need(cap): assert cap=='sandbox:run'
    return SimpleNamespace(_hive=hive,_program={'id':'omega-tools','path':str(PACKAGE),'digest':Programs.source_digest(PACKAGE)},actor={'id':'synthetic','kind':'mind','route':'agent','swarm_id':'swarm'},command={'route':'agent','action':'run-native'},swarm_id='swarm',_need=need)

def call(ctx,skill,args,pin=None):
    return asyncio.run(run_for_actor(ctx,{'skill':skill,'arguments':args,'review_receipt':pin or digest(PACKAGE/'evidence/all-tools-pack-check.json'),'base_revision':None}))

def test_catalogue_twenty_advisory_modules_eligible(config):
    registry=ToolRegistry(CORE, admitted_programs())
    assert len(registry.catalogue())==20
    assert sum(x['activatable'] for x in registry.catalogue())==20
    for family in ('home_assistant','living_home','atom_recall'):
        assert registry.select(['omegahive.tools.'+family+'@0.1.0'])

@pytest.mark.parametrize('value',[None,'x',['x'],TOOLS+TOOLS])
def test_selection_shapes_refused(value):
    with pytest.raises(ValueError):clean_selection(value)

@pytest.mark.parametrize('field,value',[('actor',{}),('command',{}),('swarm_id','other')])
def test_forged_context_refused(ctx,field,value):
    setattr(ctx,field,value)
    with patch.object(sandbox_run,'run',side_effect=AssertionError('must not execute')):
        assert call(ctx,'tools-prediction-score',[])['kind']=='ToolAdmissionRefused'

@pytest.mark.parametrize('field,value', [('path','/unadmitted-release'), ('digest','sha256:'+'0'*64)])
def test_stale_app_context_cannot_select_another_release(ctx, field, value):
    ctx._program[field] = value
    with patch.object(sandbox_run, 'run', side_effect=AssertionError('must not execute')):
        out = call(ctx, 'tools-prediction-score', [])
        assert out['kind'] == 'ToolAdmissionRefused' and out['reason'] == 'app-context-release-changed'

@pytest.mark.parametrize('condition',['stale','disabled','shape','busy','unknown-kind','networkless-config'])
def test_refusals_before_execution(ctx,monkeypatch,condition):
    pin=None;args=[]
    if condition=='stale':pin='0'*64
    if condition=='disabled':ctx._hive.agent('synthetic')['options']['tools']=[]
    if condition=='busy':ctx._hive._tools_active={'synthetic'}
    if condition=='unknown-kind':ctx._hive.agent('synthetic')['kind']='anonymous'
    if condition=='networkless-config':monkeypatch.setenv('HIVE_SANDBOX_RUN_APPS','')
    with patch.object(sandbox_run,'run',side_effect=AssertionError('must not execute')):
        assert call(ctx,'tools-prediction-score',args,pin)['kind']=='ToolAdmissionRefused'

@pytest.mark.skipif(sandbox_run.backend() != 'sandbox-exec',reason='macOS sandbox required')
def test_four_declared_skills_through_actual_shared_sandbox(ctx):
    from hive.spaces.sexpr import parse
    cases=json.loads((PACKAGE/'examples.json').read_text())['cases']
    for skill in ('tools-attention-select','tools-attention-event','tools-ensemble-compare','tools-prediction-score'):
        candidates=[c for c in cases if parse(c['call'])[0]==skill]
        for case in candidates:
            tree=parse(case['call'])
            from hive.core.tools import admit
            try:admit(json.loads((PACKAGE/'admission.json').read_text()),skill,tree[1:])
            except ValueError:continue
            out=call(ctx,skill,tree[1:])
            assert out['kind']=='ToolResult',out
            assert out['shared_runner'] and out['authority']=='none'
            actual=[x.replace('True','true').replace('False','false') for x in out['results']]
            if 'expected' in case: assert actual==[x.replace('True','true').replace('False','false') for x in case['expected']]
            else: assert len(actual)==1 and all(x.replace('True','true').replace('False','false') in actual[0] for x in case['contains'])
            break
        else:pytest.fail('no admissible banked case '+skill)
    assert not ctx._hive._tools_active

@pytest.mark.parametrize('fault',['exit','truncated','missing','partial','changed'])
def test_bad_results_and_selection_drift_suppress_delivery(ctx,fault):
    out={'kind':'ToolResult','authority':'none','results':['true']}
    if fault=='partial':out.update(kind='ToolLimitExceeded',limit='time')
    async def run(*a,**kw):
        if fault=='changed':ctx._hive.agent('synthetic')['options']['tools']=[]
        return {'exit':1 if fault=='exit' else 0,'stdout_truncated':fault=='truncated','stderr':b'',
                'missing_outputs':['result.json'] if fault=='missing' else [],'outputs':{'result.json':json.dumps(out).encode()}}
    case=json.loads((PACKAGE/'examples.json').read_text())['cases']
    from hive.spaces.sexpr import parse
    tree=next(parse(c['call']) for c in case if parse(c['call'])[0]=='tools-prediction-score')
    with patch.object(sandbox_run,'run',run):
        assert call(ctx,tree[0],tree[1:])['kind']=='ToolAdmissionRefused'
    assert not ctx._hive._tools_active


@pytest.mark.parametrize('phase', ['before', 'during'])
def test_engine_drift_refuses_native_before_launch_or_result_delivery(ctx, tmp_path, phase):
    """Only copy the six reviewed engine files, never modify the configured engine."""
    manifest = json.loads((PACKAGE/'foundations/manifest.json').read_text())
    engine = tmp_path/'engine'
    for relative in manifest['engine']['source_pins']:
        target = engine/relative; target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((Path(PETTA)/relative).read_bytes())
    ctx._hive.settings.petta_path = str(engine)
    altered = engine/'LICENSE'
    if phase == 'before': altered.write_text('synthetic changed engine fixture')
    calls = []
    async def run(*args, **kwargs):
        calls.append(True)
        assert phase == 'during', 'engine drift must refuse before launching'
        altered.write_text('synthetic changed engine fixture')
        result = {'kind':'ToolResult','authority':'none','results':['true']}
        return {'exit':0,'stdout_truncated':False,'stderr':b'', 'missing_outputs':[],
                'outputs':{'result.json':json.dumps(result).encode()}}
    args = [['PredictionSampleV1','p1','m1','context',4,0.75], ['TargetSampleV1','t1','context',5,0]]
    with patch.object(sandbox_run, 'run', run):
        assert call(ctx, 'tools-prediction-score', args)['kind'] == 'ToolAdmissionRefused'
    assert len(calls) == (1 if phase == 'during' else 0)
    assert not ctx._hive._tools_active

def test_workspace_has_wrappers_no_native_mount_or_plan(ctx,tmp_path):
    settings=SimpleNamespace(core_root=CORE,petta_path=PETTA,offline=True,default_driver='local',data_dir=tmp_path,agents_dir=tmp_path/'agents')
    ws=Workspace(settings,ctx._hive.programs);agent=ctx._hive.agent('synthetic');ws.path(agent['id']).mkdir(parents=True)
    ws.write_tools(agent)
    run=(ws.path(agent['id'])/'run.metta').read_text()
    assert 'helper_tools.call' in run and 'omegahive-tools' not in run
    assert not (ws.path(agent['id'])/'repos/omegahive-tools').exists()
    assert not (tmp_path/'tools-plans').exists() and not (tmp_path/'tools-native').exists()
    spec=importlib.util.spec_from_file_location('parser_test',CORE/'src/helper_command_parser.py')
    parser=importlib.util.module_from_spec(spec);sys.path.insert(0,str(CORE/'src'))
    with patch.dict(os.environ,{'OMEGACLAW_EXTRA_LOADER':str(ws.path(agent['id'])/'memory/tools-loader.metta')}):
        spec.loader.exec_module(parser)
        parsed=parser._signature_parse_one('tools-prediction-score [[prediction, claim, 0.8, witness, ctx], [prediction-target, claim, 1, receipt, ctx]]')
        assert parsed.startswith('(tools-prediction-score "'),parsed
    loop=(CORE/'src/loop.metta').read_text()
    assert 'helper.is_tool_command' not in loop and '(once (reduce $cmd))' in loop


def test_generated_native_wrapper_and_ordinary_execution(ctx,tmp_path,monkeypatch):
    """Actual generated wrapper/import/native equation; inert HTTP stand-in.
    Actual authenticated API/native sandbox separately exercised above.
    """
    import io
    import urllib.request
    sys.path.insert(0,str(Path(PETTA)/'python'))
    from petta import PeTTa
    import janus_swi as janus
    settings=SimpleNamespace(core_root=CORE,petta_path=PETTA,offline=True,default_driver='local',data_dir=tmp_path,agents_dir=tmp_path/'agents')
    ws=Workspace(settings,ctx._hive.programs);agent=ctx._hive.agent('synthetic');ws.path(agent['id']).mkdir(parents=True)
    ws.write_tools(agent)
    alias=tmp_path/'OmegaClaw-Core';alias.symlink_to(CORE)
    monkeypatch.setenv('HIVE_API_URL','http://synthetic.invalid')
    monkeypatch.setenv('HIVE_WS_TOKEN','synthetic-not-real')
    monkeypatch.setenv('OMEGACLAW_TOOLS_RECEIPT',digest(PACKAGE/'evidence/all-tools-pack-check.json'))
    seen=[]
    def urlopen(req,timeout):
        body=json.loads(req.data);seen.append(body)
        assert req.full_url=='http://synthetic.invalid/api/agent/programs/omega-tools/act'
        assert body['action']=='run-native' and body['params']['skill']=='tools-prediction-score'
        assert type(body['params']['arguments']) is list and 'actor' not in body
        return io.BytesIO(json.dumps({'status':'done','detail':{'kind':'ToolResult','authority':'none','results':['(synthetic-score 0.04)']}}).encode())
    monkeypatch.setattr(urllib.request,'urlopen',urlopen)
    native=PeTTa(petta_path=PETTA)
    janus.query_once('asserta(library_path(Base))',{'Base':str(alias)})
    try:
        native.process_metta_string('!(import! &self (library lib_import))')
        equations=tmp_path/'command-fixture.metta'
        equations.write_text('!(import_prolog_function once)\n(= (command-execute $cmd) (once (reduce $cmd)))\n(= (ordinary-fixture $value) $value)\n')
        native.load_metta_file(str(equations))
        # Differential control: this isolated native fixture does not import the
        # full loop's ordinary skills. Compare upstream behaviour, not an
        # invented success value for an incomplete bootstrap.
        ordinary_before=native.process_metta_string('!(command-execute (ordinary-fixture normal-result))')
        native.load_metta_file(str(ws.path(agent['id'])/'memory/tools-loader.metta'))
        text=json.dumps([['prediction','claim',0.8,'witness','ctx'],['prediction-target','claim',1,'receipt','ctx']])
        out=native.process_metta_string('!(command-execute (tools-prediction-score '+json.dumps(text)+'))')
        assert len(seen)==1 and len(out)==1 and 'ToolResult' in out[0] and 'authority-none' in out[0],out
        assert native.process_metta_string('!(command-execute (ordinary-fixture normal-result))')==ordinary_before
        assert len(seen)==1
    finally:
        janus.query_once('retractall(library_path(Base))',{'Base':str(alias)})


def test_production_supervisor_rebuilds_and_disables_wrappers(ctx,tmp_path):
    from hive.supervisor.drivers import Supervisor
    settings=SimpleNamespace(core_root=CORE,petta_path=PETTA,offline=True,default_driver='local',data_dir=tmp_path,agents_dir=tmp_path/'agents',public_url='http://synthetic.invalid')
    agent=ctx._hive.agent('synthetic'); calls=[]
    class Driver:
        state='running'
        def status(self,aid):return self.state
        def stop(self,aid):calls.append('stop');self.state='absent'
        def start(self,a,env):calls.append('start');self.state='running'
    driver=Driver(); supervisor=Supervisor(settings,drivers={'local':driver})
    supervisor.attach(ctx._hive);supervisor.workspace.path(agent['id']).mkdir(parents=True)
    supervisor.workspace.token=lambda aid:'synthetic-not-real'
    supervisor.reconfigure_tools(agent)
    assert calls==['stop','start']
    assert 'helper_tools.call' in (supervisor.workspace.path(agent['id'])/'run.metta').read_text()
    driver.state='absent';calls.clear();agent['options']['tools']=[]
    supervisor.reconfigure_tools(agent)
    assert calls==['stop'] and (supervisor.workspace.path(agent['id'])/'run.metta').read_text()==RUN_METTA

@pytest.mark.parametrize('foundation',[False,True])
def test_preflight_availability_probe_does_not_block_event_loop(ctx,monkeypatch,foundation):
    """sandbox_run.available() runs a launcher subprocess (up to 10 s): run_for_actor awaits it off the loop, so a
    slow probe never stalls a concurrent request. Behaviour is unchanged: an unavailable sandbox still refuses."""
    import threading, time
    probe_threads=[]
    def slow_available():
        probe_threads.append(threading.current_thread() is threading.main_thread())
        time.sleep(0.6); return False
    monkeypatch.setattr(sandbox_run,'available',slow_available)
    pin=digest(PACKAGE/'evidence/all-tools-pack-check.json')
    if foundation:
        ctx.command={'route':'agent','action':'run-foundation'}
        params={'request':{'recipe':'synthetic'},'review_receipt':pin,'base_revision':None}
    else:
        from hive.spaces.sexpr import parse
        from hive.core.tools import admit
        schema=json.loads((PACKAGE/'admission.json').read_text())
        def admissible(tree):
            try: admit(schema,tree[0],tree[1:]); return True
            except ValueError: return False
        tree=next(t for t in (parse(c['call']) for c in json.loads((PACKAGE/'examples.json').read_text())['cases']) if t[0] in ('tools-attention-select','tools-attention-event','tools-ensemble-compare','tools-prediction-score') and admissible(t))
        params={'skill':tree[0],'arguments':tree[1:],'review_receipt':pin,'base_revision':None}
    async def main():
        gaps=[]; done=asyncio.Event()
        async def concurrent_request():
            last=time.monotonic()
            while not done.is_set():
                await asyncio.sleep(0.01); t=time.monotonic(); gaps.append(t-last); last=t
        ticker=asyncio.create_task(concurrent_request())
        try: out=await run_for_actor(ctx,params,foundation=foundation)
        finally: done.set(); await ticker
        return out,gaps
    out,gaps=asyncio.run(main())
    assert probe_threads==[False], out                  # the probe ran, and not on the loop's thread
    assert out['kind']=='ToolAdmissionRefused'          # unavailable sandbox still refuses, as before
    assert len(gaps)>=20 and max(gaps)<0.3              # the loop kept serving the concurrent request
