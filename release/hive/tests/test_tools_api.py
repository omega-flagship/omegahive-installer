"""Admin selection and authenticated caller kinds using an isolated app fixture."""
import json
import os
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.tools import digest
from hive.core.programs import Programs
from hive.tests.test_core_api import FakeSupervisor
from hive.tests.test_visibility import person

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = os.environ.get('OMEGA_TOOLS_TEST_PACKAGE')
PETTA = os.environ.get('PETTA_PATH')
pytestmark = pytest.mark.skipif(not PACKAGE or not PETTA, reason='explicit reviewed pack and PeTTa required')

class SupervisorFixture(FakeSupervisor):
    def reconfigure_tools(self, agent): self.calls.append(('tools-reconfigure',agent['id']))

def fixture_app_pin(root):
    return {'release':str(root),'digest':Programs.source_digest(root),
            'files':{'release-data.lock.json':digest(root/'release-data.lock.json')}}

@pytest.fixture
def client(monkeypatch,tmp_path):
    root = Path(PACKAGE).resolve()
    plugin = root/'programs/omega-tools' if (root/'programs/omega-tools/plugin.json').is_file() else root
    monkeypatch.setenv('HIVE_PLUGIN_DIRS',str(plugin))
    monkeypatch.setenv('HIVE_APP_PINS',json.dumps({'omega-tools':fixture_app_pin(root)}))
    monkeypatch.setenv('HIVE_SANDBOX_RUN_APPS','omega-tools')
    monkeypatch.setenv('HIVE_SANDBOX_RUNTIMES',json.dumps({'metta':{'exe':sys.executable,'reads':[sys.prefix,PETTA]}}))
    settings = load_settings(data_dir=tmp_path/'hive',admin_password='synthetic-test',
                             petta_path=PETTA,core_root=ROOT,offline=True,default_driver='local')
    app = create_app(settings,supervisor=SupervisorFixture(),reconcile_seconds=0)
    with TestClient(app) as c:
        token = c.post('/api/auth/login',json={'password':'synthetic-test'}).json()['token']
        c.headers['Authorization'] = 'Bearer '+token
        yield c


def test_admin_selection_multiple_minds_and_disable(client):
    catalogue = client.get('/api/tools').json()
    assert len(catalogue['items']) == 20 and catalogue['offline_candidate']
    selection = {'tools':['omegahive.tools.predictive_learning@0.1.0']}
    a = client.post('/api/agents',json={'name':'SyntheticA','options':selection}).json()
    b = client.post('/api/agents',json={'name':'SyntheticB'}).json()
    assert client.patch('/api/agents/'+b['id'],json={'options':selection}).status_code == 200
    assert client.patch('/api/agents/'+a['id'],json={'model':'openrouter/anything'}).status_code == 200
    disabled = client.patch('/api/agents/'+a['id'],json={'options':{'tools':[]}})
    assert disabled.status_code == 200 and disabled.json()['options']['tools'] == []
    assert client.app.state.hive.supervisor.calls[-1] == ('tools-reconfigure',a['id'])
    calls = list(client.app.state.hive.supervisor.calls)
    assert client.patch('/api/agents/'+b['id'],json={'options':selection}).status_code == 200
    assert client.app.state.hive.supervisor.calls == calls  # no rebuild when selection did not change


def test_member_and_agent_cannot_change_tools(client):
    member = person(client,'u_tools_fixture')
    selection = {'tools':['omegahive.tools.predictive_learning@0.1.0']}
    assert client.post('/api/agents',headers=member,json={'name':'NoAdmin','options':selection}).status_code == 403
    own = client.post('/api/agents',headers=member,json={'name':'OwnedByMember'}).json()
    assert client.patch('/api/agents/'+own['id'],headers=member,json={'options':selection}).status_code == 403
    a = client.post('/api/agents',json={'name':'PrivateSynthetic','options':selection}).json()
    agent_header = {'Authorization':'Bearer '+a['token']}
    assert client.get('/api/tools',headers=agent_header).status_code == 401
    assert client.patch('/api/agents/'+a['id'],headers=agent_header,json={'options':{'tools':[]}}).status_code == 401


def test_advisory_families_all_caller_kinds_no_offline_dependency(client):
    for family in ('home_assistant','habitat_snapshot','living_home','goal_compass'):
        assert client.post('/api/agents',json={'name':'Advisory','options':{'tools':['omegahive.tools.'+family+'@0.1.0']}}).status_code == 200
    client.app.state.hive.settings.offline = False
    assert client.post('/api/agents',json={'name':'Advisory','options':{'tools':['omegahive.tools.attention@0.1.0']}}).status_code == 200


def test_failed_evaluator_preflight_leaves_options_unmodified(client,monkeypatch):
    a = client.post('/api/agents',json={'name':'Synthetic'}).json()
    monkeypatch.setenv('HIVE_SANDBOX_RUNTIMES','{}')
    result = client.patch('/api/agents/'+a['id'],json={'options':{'tools':['omegahive.tools.attention@0.1.0']}})
    assert result.status_code == 400
    assert not client.app.state.hive.agent(a['id'])['options'].get('tools')


@pytest.mark.parametrize('state', ['unpinned', 'disabled', 'mismatch'])
def test_cached_module_adapter_rechecks_owner_app_admission(client, monkeypatch, state):
    from hive.core.tools import ToolRegistry
    hive = client.app.state.hive
    adapter = ToolRegistry(ROOT, hive.programs)
    assert len(adapter.catalogue()) == 20
    if state == 'disabled':
        hive.programs.set_enabled('omega-tools', False)
    else:
        pin = fixture_app_pin(Path(PACKAGE))
        if state == 'mismatch': pin['digest'] = 'sha256:' + '0'*64
        monkeypatch.setenv('HIVE_APP_PINS', json.dumps({} if state == 'unpinned' else {'omega-tools':pin}))
        hive.programs.reload()  # owner/operator full reload snapshots new pins
    assert hive.programs.pinned_release('omega-tools') is None
    with pytest.raises(ValueError, match='pinned-release-unavailable'):
        adapter.select(['omegahive.tools.attention@0.1.0'])
    assert not adapter.modules  # old discovery never survives a refusal


def test_removed_package_environment_cannot_redirect_discovery(client, monkeypatch, tmp_path):
    from hive.core.tools import ToolRegistry
    other = tmp_path/'untrusted-root'; other.mkdir()
    monkeypatch.setenv('HIVE_TOOL_DIRS', str(other))
    monkeypatch.setenv('HIVE_TOOLS_REVIEW_PINS', json.dumps({str(other):'0'*64}))
    adapter = ToolRegistry(ROOT, client.app.state.hive.programs)
    assert len(adapter.catalogue()) == 20
    assert adapter.roots == [Path(PACKAGE).resolve()]
    assert adapter.release['digest'] == fixture_app_pin(Path(PACKAGE))['digest']


@pytest.mark.parametrize('forge_lock', [False, True])
def test_module_data_tamper_cannot_admit_itself_by_rewriting_receipt(client, monkeypatch, tmp_path, forge_lock):
    import shutil
    from hive.core.tools import ToolRegistry
    root = tmp_path/'synthetic-release'
    shutil.copytree(PACKAGE, root)
    for path in [root, *root.rglob('*')]:
        path.chmod(0o700 if path.is_dir() else 0o600)  # own disposable copy only
    pin = fixture_app_pin(root)
    monkeypatch.setenv('HIVE_PLUGIN_DIRS', str(root))
    monkeypatch.setenv('HIVE_APP_PINS', json.dumps({'omega-tools':pin}))
    hive = client.app.state.hive
    hive.programs.reload()
    adapter = ToolRegistry(ROOT, hive.programs)
    assert len(adapter.catalogue()) == 20
    relative = 'modules/tools_attention/module.toml'
    path = root/relative; path.write_text(path.read_text()+'\n# synthetic changed admission data\n')
    receipt = root/'evidence/all-tools-pack-check.json'
    body = json.loads(receipt.read_text()); body['files'][relative] = digest(path)
    receipt.write_text(json.dumps(body))
    if forge_lock:
        lock = root/'release-data.lock.json'; data = json.loads(lock.read_text())
        data['files'][relative] = digest(path)
        data['files']['evidence/all-tools-pack-check.json'] = digest(receipt)
        lock.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        adapter.select(['omegahive.tools.attention@0.1.0'])
    assert not adapter.modules
    peer = client.post('/api/agents', json={'name':'Tamper refusal fixture'}).json()
    denied = client.patch('/api/agents/'+peer['id'], json={'options':{'tools':['omegahive.tools.attention@0.1.0']}})
    assert denied.status_code == 400
    assert not hive.agent(peer['id'])['options'].get('tools')


@pytest.mark.parametrize('change', ['disabled', 'replaced'])
def test_app_release_change_during_calculation_suppresses_delivery(client, monkeypatch, tmp_path, change):
    import shutil
    from hive.core import sandbox_run
    hive = client.app.state.hive
    swarm = client.post('/api/swarms', json={'name':'Release transition swarm'}).json()
    peer = client.post('/api/agents', json={'name':'Release transition fixture', 'kind':'module',
                       'swarm_id':swarm['id'],
                       'options':{'tools':['omegahive.tools.predictive_learning@0.1.0']}}).json()
    client.post('/api/policy', json={'scope':'agent:'+peer['id'], 'skill':'program:omega-tools:run-native', 'mode':'allow'}).raise_for_status()
    started = []
    async def run(*args, **kwargs):
        started.append(True)
        if change == 'disabled':
            hive.programs.set_enabled('omega-tools', False)
        else:
            other = tmp_path/'successor-release'; shutil.copytree(PACKAGE, other)
            for path in [other, *other.rglob('*')]:
                path.chmod(0o700 if path.is_dir() else 0o600)
            monkeypatch.setenv('HIVE_PLUGIN_DIRS', str(other))
            monkeypatch.setenv('HIVE_APP_PINS', json.dumps({'omega-tools':fixture_app_pin(other)}))
            hive.programs.reload()
        result = {'kind':'ToolResult', 'authority':'none', 'results':['SHOULD_NOT_BE_DELIVERED']}
        return {'exit':0, 'stdout_truncated':False, 'stderr':b'', 'missing_outputs':[],
                'outputs':{'result.json':json.dumps(result).encode()}}
    monkeypatch.setattr(sandbox_run, 'run', run)
    body = {'action':'run-native','items':[], 'idempotency_key':'transition-'+change,
            'params':{'skill':'tools-prediction-score', 'review_receipt':digest(Path(PACKAGE)/'evidence/all-tools-pack-check.json'),
                      'arguments':[['PredictionSampleV1','p1','m1','context',4,0.75], ['TargetSampleV1','t1','context',5,0]]}}
    out = client.post('/api/agent/programs/omega-tools/act', headers={'Authorization':'Bearer '+peer['token']}, json=body)
    assert len(started) == 1, out.text
    assert out.status_code == 200 and out.json()['status'] == 'refused'
    assert out.json()['detail']['results'] == [] and 'SHOULD_NOT_BE_DELIVERED' not in out.text


@pytest.mark.parametrize('backend', ['landlock', 'none'])
def test_unsupported_bundle_backend_refuses_selection_before_workspace_or_runner(client, monkeypatch, backend):
    from hive.core import sandbox_run
    peer = client.post('/api/agents',json={'name':'Unavailable bundle fixture'}).json()
    monkeypatch.setattr(sandbox_run, 'backend', lambda: backend)
    if backend == 'landlock':
        # r14 (ported onto main): Landlock + namespaces is a bundle boundary only when the launcher's
        # exact-limit pre-check also passes (Linux: a working prlimit). Mind isolation alone admits nothing,
        # on any host: the shared available() predicate refuses before workspace or runner.
        monkeypatch.setattr(sandbox_run, '_launcher_works', lambda: False)
    async def forbidden(*args, **kwargs):
        raise AssertionError('unsupported bundle must not launch a job')
    monkeypatch.setattr(sandbox_run, 'run', forbidden)
    assert not sandbox_run.available()
    result = client.patch('/api/agents/'+peer['id'], json={'options':{'tools':['omegahive.tools.attention@0.1.0']}})
    assert result.status_code == 400
    assert not client.app.state.hive.agent(peer['id'])['options'].get('tools')


def test_concurrent_enablement_allows_independent_minds(client):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from hive.core.hive import HiveError
    hive = client.app.state.hive
    a = client.post('/api/agents',json={'name':'ConcurrentA'}).json()
    b = client.post('/api/agents',json={'name':'ConcurrentB'}).json()
    gate = threading.Barrier(2)
    def enable(aid):
        gate.wait(timeout=5)
        try:
            hive.update_agent(aid,{'options':{'tools':['omegahive.tools.attention@0.1.0']}})
            return 'enabled'
        except HiveError: return 'refused'
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(enable,[a['id'],b['id']])) == ['enabled','enabled']
    assert sum(bool(hive.agent(aid)['options'].get('tools')) for aid in (a['id'],b['id'])) == 2


def test_stale_permission_baseline_cannot_silently_disable_tools(client):
    from hive.core.hive import HiveError
    hive = client.app.state.hive
    a = client.post('/api/agents',json={'name':'Synthetic'}).json()
    hive.update_agent(a['id'],{'options':{'tools':['omegahive.tools.attention@0.1.0']}})
    with pytest.raises(HiveError) as error:
        hive.update_agent(a['id'],{'options':{}},expected_tools=[])
    assert error.value.status == 409
    assert hive.agent(a['id'])['options']['tools'] == ['omegahive.tools.attention@0.1.0']


def test_refused_tools_do_not_change_swarm_membership(client):
    a = client.post('/api/agents',json={'name':'Synthetic'}).json()
    s = client.post('/api/swarms',json={'name':'SyntheticSwarm'}).json()
    response = client.patch('/api/agents/'+a['id'],json={'swarm_id':s['id'], 'options':{'tools':['omegahive.tools.home_assistant@99.0.0']}})
    assert response.status_code == 400
    assert client.app.state.hive.agent(a['id'])['swarm_id'] is None


@pytest.mark.parametrize('kind', ['omega', 'iter', 'module'])
def test_authenticated_caller_kinds_real_native_and_foundations(client, kind):
    """Real host authorization AND actual sandbox computation, without waking a mind."""
    from hive.core import sandbox_run
    if sandbox_run.backend() != 'sandbox-exec': pytest.skip('actual Mac OS sandbox required')
    package = Path(PACKAGE)
    hive = client.app.state.hive
    hive.settings.offline = False  # compute must not depend on offline/mock routing
    swarm = client.post('/api/swarms', json={'name': 'Synthetic peer acceptance'}).json()
    agent = client.post('/api/agents', json={'name': 'Peer ' + kind, 'kind': kind, 'swarm_id': swarm['id'],
                        'options': {'tools': ['omegahive.tools.predictive_learning@0.1.0']}}).json()
    assert 'token' in agent, agent
    headers = {'Authorization': 'Bearer ' + agent['token']}
    pin = digest(package / 'evidence/all-tools-pack-check.json')
    arguments = [['PredictionSampleV1', 'p1', 'm1', 'context', 4, 0.75], ['TargetSampleV1', 't1', 'context', 5, 0]]
    body = {'action': 'run-native', 'items': [], 'params': {'skill': 'tools-prediction-score', 'arguments': arguments,
            'review_receipt': pin}, 'idempotency_key': 'native-' + kind}
    denied = client.post('/api/agent/programs/omega-tools/act', headers=headers, json=body)
    assert denied.status_code == 403 and denied.json()['error']['code'] == 'policy_refused'
    for action in ('run-native', 'run-foundation'):
        response = client.post('/api/policy', json={'scope': 'agent:' + agent['id'], 'skill': 'program:omega-tools:' + action, 'mode': 'allow'})
        assert response.status_code == 200
    result = client.post('/api/agent/programs/omega-tools/act', headers=headers, json=body)
    assert result.status_code == 200, result.text
    assert result.json()['status'] == 'done', result.text
    assert result.json()['detail']['kind'] == 'ToolResult' and result.json()['detail']['provider_calls'] == 0
    assert result.json()['detail']['app_release_digest'] == hive.programs.pinned_release('omega-tools')['digest']
    from hive.core.tools import ToolRegistry
    engine_fingerprint = ToolRegistry(ROOT, hive.programs).verify_engine(PETTA)
    assert result.json()['detail']['engine_source_fingerprint'] == engine_fingerprint
    cases = json.loads((package / 'foundations/examples.json').read_text())['cases']
    seen = set()
    for case in cases:
        recipe = case['request']['recipe']
        if recipe in seen or (kind != 'module' and seen): continue
        seen.add(recipe)
        result = client.post('/api/agent/programs/omega-tools/act', headers=headers, json={
            'action': 'run-foundation', 'items': [], 'idempotency_key': 'foundation-' + recipe,
            'params': {'request': case['request'], 'review_receipt': pin}})
        assert result.status_code == 200 and result.json()['status'] == 'done', result.text
        assert result.json()['detail']['kind'] == 'FoundationResult', result.text
        assert result.json()['detail']['results'] == case['expected']
        assert result.json()['detail']['state_scope'] == 'job-local'
        assert result.json()['detail']['engine_source_fingerprint'] == engine_fingerprint
    assert len(seen) == (5 if kind == 'module' else 1)
    assert hive.db.one('SELECT desired FROM agents WHERE id=?', (agent['id'],))['desired'] == 'stopped'


def test_program_route_identity_policy_fresh_read_retry_and_revoke(client,monkeypatch):
    from hive.spaces.sexpr import parse
    package=Path(PACKAGE)
    pin=digest(package/'evidence/all-tools-pack-check.json')
    hive=client.app.state.hive
    swarm=client.post('/api/swarms',json={'name':'Offline synthetic'}).json()
    a=client.post('/api/agents',json={'name':'Test mind','swarm_id':swarm['id'],'options':{'tools':['omegahive.tools.predictive_learning@0.1.0']}}).json()
    header={'Authorization':'Bearer '+a['token']}
    cases=json.loads((package/'examples.json').read_text())['cases']
    tree=next(parse(c['call']) for c in cases if parse(c['call'])[0]=='tools-prediction-score')
    body={'action':'run-native','items':[],'params':{'skill':tree[0],'arguments':tree[1:],'review_receipt':pin},'idempotency_key':'synthetic-call-1'}
    route='/api/agent/programs/omega-tools/act'
    assert client.post(route,headers=header,json={**body,'actor':'forged'}).status_code==400
    assert client.post(route,headers=header,json=body).status_code==403
    # A wildcard ordinary-skill allowance never grants an app action.
    broad=hive.policy.add_rule('agent:'+a['id'],'*','allow')
    assert client.post(route,headers=header,json=body).status_code==403
    rule=hive.policy.add_rule('agent:'+a['id'],'program:omega-tools:run-native','allow')
    out=client.post(route,headers=header,json=body)
    assert out.status_code==200,out.text
    assert out.json()['status']=='done' and out.json()['detail']['shared_runner']
    assert out.json()['detail']['authority']=='none'
    # r15 reads rerun under current access, rather than retaining raw results.
    from hive.core import sandbox_run
    original = sandbox_run.run
    reruns = []
    async def tracked(*a,**kw):
        reruns.append(True)
        return await original(*a,**kw)
    monkeypatch.setattr(sandbox_run,'run',tracked)
    retry = client.post(route,headers=header,json=body)
    assert retry.status_code == 200 and retry.json() == out.json()
    assert len(reruns) == 1
    stored = json.loads(hive.db.one('SELECT result FROM program_actions WHERE principal=? AND program=? AND idempotency_key=?',
                        ('agent:'+a['id'],'omega-tools',body['idempotency_key']))['result'])
    assert set(stored) == {'redacted','digest','status'} and stored['redacted'] == 'read'
    different={**body,'params':{**body['params'],'arguments':[]}}
    assert client.post(route,headers=header,json=different).status_code==409
    hive.policy.delete_rule(rule['id'])
    # Both the original retry key and a fresh key recheck revocation before run.
    assert client.post(route,headers=header,json=body).status_code==403
    assert client.post(route,headers=header,json={**body,'idempotency_key':'after-revoke'}).status_code==403
    assert len(reruns) == 1
    # Changing the execution driver cannot retain a selected Tools mind.
    result=client.patch('/api/agents/'+a['id'],json={'driver':'docker'})
    assert result.status_code==400


def test_inspection_release_read_actions_reach_all_caller_kinds(client, monkeypatch):
    """The exact installed inspection package on r15, not cloud credentials."""
    inspection = Path(PACKAGE).parent/'0.5.0-inspection'
    assert inspection.is_dir()
    monkeypatch.setenv('HIVE_PLUGIN_DIRS', str(inspection))
    monkeypatch.setenv('HIVE_APP_PINS',json.dumps({'omega-tools':fixture_app_pin(inspection)}))
    assert client.post('/api/programs/reload').status_code == 200
    hive = client.app.state.hive
    module = hive.programs._ready('omega-tools')['module']
    revision = module.view(None, None, 'map')['revision']
    calls = []
    original = module.act
    def traced(ctx, action, items, params):
        calls.append({'id':ctx.actor['id'], 'route':ctx.actor['route'], 'read_only':ctx.read_only})
        return original(ctx, action, items, params)
    monkeypatch.setattr(module, 'act', traced)
    swarm = client.post('/api/swarms', json={'name':'Inspection peer fixture'}).json()
    for kind in ('omega', 'iter', 'module'):
        peer = client.post('/api/agents', json={'name':'Stopped inspector '+kind, 'kind':kind,
                           'swarm_id':swarm['id'], 'budget_usd':0}).json()
        headers = {'Authorization':'Bearer '+peer['token']}
        body = {'action':'inspect-tool','items':['attention'],'params':{},
                'base_revision':revision, 'idempotency_key':'inspection-'+kind}
        route = '/api/agent/programs/omega-tools/act'
        before = len(calls)
        assert client.post(route, headers=headers, json=body).status_code == 403
        assert len(calls) == before
        rule = hive.policy.add_rule('agent:'+peer['id'], 'program:omega-tools:inspect-tool', 'allow')
        first = client.post(route, headers=headers, json=body)
        assert first.status_code == 200 and first.json()['status'] == 'done', first.text
        assert client.post(route, headers=headers, json=body).json() == first.json()
        assert calls[before:] == [{'id':peer['id'],'route':'agent','read_only':True}]*2
        stored = json.loads(hive.db.one('SELECT result FROM program_actions WHERE principal=? AND program=? AND idempotency_key=?',
                            ('agent:'+peer['id'],'omega-tools',body['idempotency_key']))['result'])
        assert set(stored) == {'redacted','digest','status'}
        hive.policy.delete_rule(rule['id'])
        assert client.post(route, headers=headers, json=body).status_code == 403
        assert len(calls) == before+2
        assert hive.db.one('SELECT desired FROM agents WHERE id=?', (peer['id'],))['desired'] == 'stopped'
        assert hive.agent(peer['id'])['spent_usd'] == 0


def mutable_release_fixture(path):
    import shutil
    shutil.copytree(PACKAGE, path)
    for p in [path, *path.rglob('*')]:
        p.chmod(0o700 if p.is_dir() else 0o600)
    return path


def mount_release_fixture(hive, monkeypatch, root, pin=None):
    monkeypatch.setenv('HIVE_PLUGIN_DIRS', str(root))
    monkeypatch.setenv('HIVE_APP_PINS', json.dumps({'omega-tools':pin or fixture_app_pin(root)}))
    hive.programs.reload()


def test_valid_source_pin_without_pinned_data_lock_refuses_tools(client, monkeypatch):
    from hive.core.tools import ToolRegistry
    hive = client.app.state.hive
    root = Path(PACKAGE)
    pin = fixture_app_pin(root); pin.pop('files')
    mount_release_fixture(hive, monkeypatch, root, pin)
    # A valid app SOURCE pin is deliberately still admitted by the owner.
    assert hive.programs.pinned_release('omega-tools')['files'] == {}
    with pytest.raises(ValueError, match='release_data_unpinned'):
        ToolRegistry(ROOT, hive.programs).select(['omegahive.tools.attention@0.1.0'])
    peer = client.post('/api/agents', json={'name':'Unpinned data fixture'}).json()
    out = client.patch('/api/agents/'+peer['id'], json={'options':{'tools':['omegahive.tools.attention@0.1.0']}})
    assert out.status_code == 400 and not hive.agent(peer['id'])['options'].get('tools')


@pytest.mark.parametrize('relative', ['modules/tools_attention/module.toml', 'modules/tools_attention/spec.json',
    'modules/tools_attention/exports.json', 'admission.json', 'foundations/manifest.json', 'foundations/runner.py'])
def test_admitted_lock_must_cover_every_consumed_package_file(client, monkeypatch, tmp_path, relative):
    from hive.core.tools import ToolRegistry
    root = mutable_release_fixture(tmp_path/'incomplete-data-closure')
    receipt = root/'evidence/all-tools-pack-check.json'
    body = json.loads(receipt.read_text()); body['files'].pop(relative, None); receipt.write_text(json.dumps(body))
    lock = root/'release-data.lock.json'
    body = json.loads(lock.read_text()); body['files'].pop(relative)
    body['files']['evidence/all-tools-pack-check.json'] = digest(receipt); lock.write_text(json.dumps(body))
    hive = client.app.state.hive
    mount_release_fixture(hive, monkeypatch, root)
    assert hive.programs.pinned_release('omega-tools')
    adapter = ToolRegistry(ROOT, hive.programs)
    with pytest.raises(ValueError, match='release-data-file-uncovered'):
        adapter.select(['omegahive.tools.attention@0.1.0'])
        adapter.verify_engine(PETTA)


@pytest.mark.parametrize('phase', ['before-plan', 'during-job'])
@pytest.mark.parametrize('foundation', [False, True])
def test_same_path_source_identity_data_renewal_suppresses_calculation(client, monkeypatch, tmp_path, phase, foundation):
    from hive.core import sandbox_run
    import importlib.util
    hive = client.app.state.hive
    root = mutable_release_fixture(tmp_path/'same-path-release')
    mount_release_fixture(hive, monkeypatch, root)
    source_before = hive.programs.pinned_release('omega-tools')
    swarm = client.post('/api/swarms', json={'name':'Same source data renewal'}).json()
    peer = client.post('/api/agents', json={'name':'Data renewal peer','kind':'module','swarm_id':swarm['id'],
                  'options':{'tools':['omegahive.tools.predictive_learning@0.1.0']}}).json()
    action = 'run-foundation' if foundation else 'run-native'
    client.post('/api/policy', json={'scope':'agent:'+peer['id'], 'skill':'program:omega-tools:'+action, 'mode':'allow'}).raise_for_status()
    receipt_before = digest(root/'evidence/all-tools-pack-check.json')
    def renew_data():
        path = root/'examples.json'; data = json.loads(path.read_text()); data['synthetic_review_note'] = 'renewed data'
        path.write_text(json.dumps(data))
        receipt = root/'evidence/all-tools-pack-check.json'; body = json.loads(receipt.read_text())
        body['files']['examples.json'] = digest(path); receipt.write_text(json.dumps(body))
        lock = root/'release-data.lock.json'; body = json.loads(lock.read_text())
        body['files']['examples.json'] = digest(path); body['files']['evidence/all-tools-pack-check.json'] = digest(receipt)
        lock.write_text(json.dumps(body)); mount_release_fixture(hive, monkeypatch, root)
        current = hive.programs.pinned_release('omega-tools')
        assert all(current[k] == source_before[k] for k in ('path','digest','version'))
        assert current['files'] != source_before['files']
    original_release = hive.programs.pinned_release; lookups = []
    def release(pid):
        lookups.append(pid)
        if phase == 'before-plan' and len(lookups) == 2: renew_data()
        return original_release(pid)
    if phase == 'before-plan': monkeypatch.setattr(hive.programs, 'pinned_release', release)
    # A valid normal native/typed Foundation answer, not a fake invalid-output refusal.
    case = json.loads((root/'foundations/examples.json').read_text())['cases'][0]
    spec = importlib.util.spec_from_file_location('data_renewal_api', root/'foundations/recipe_api.py')
    api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
    started = []
    async def run(*args, **kwargs):
        started.append(True)
        assert phase == 'during-job', 'data renewal before planning must not start a job'
        renew_data()
        if foundation:
            result = {'kind':'FoundationResult','limit':None,'results':case['expected'],
                      'data':api.decode_result(case['request'],case['expected'][0]),'authority':'none','state_scope':'job-local',
                      'provider_calls':0,'persistent_writes':0,'step_unit':'SWI-Prolog inferences'}
        else: result = {'kind':'ToolResult','authority':'none','results':['SHOULD_NOT_BE_DELIVERED']}
        return {'exit':0,'stdout_truncated':False,'missing_outputs':[],'stderr':b'',
                'outputs':{'result.json':json.dumps(result).encode()}}
    monkeypatch.setattr(sandbox_run, 'run', run)
    params = {'request':case['request']} if foundation else {'skill':'tools-prediction-score',
               'arguments':[['PredictionSampleV1','p1','m1','context',4,0.75],['TargetSampleV1','t1','context',5,0]]}
    body = {'action':action,'items':[], 'idempotency_key':'data-'+str(foundation)+'-'+phase,
            'params':{**params,'review_receipt':receipt_before}}
    out = client.post('/api/agent/programs/omega-tools/act', headers={'Authorization':'Bearer '+peer['token']}, json=body)
    assert out.status_code == 200 and out.json()['status'] == 'refused', out.text
    assert out.json()['detail']['results'] == []
    assert len(started) == (1 if phase == 'during-job' else 0)
    if phase == 'before-plan': assert out.json()['detail']['reason'] == 'app-release-changed-before-plan'
