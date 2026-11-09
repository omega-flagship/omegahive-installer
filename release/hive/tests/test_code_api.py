"""R2: edit targets, opening a target as a task, and the relay to OmegaCode (faked upstream)."""

import json
import os
import pathlib

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


@pytest.fixture()
def c(monkeypatch, tmp_path):
    # These tests check route/grant semantics against an in-process fake Code service; the same-connection relay proof
    # transport (on for the pinned R1.4) is covered against real listeners in test_relay_proof / the interop tests.
    import hive.core.code as code_module
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset())
    monkeypatch.setenv("HIVE_CODE_OWNERS", json.dumps([{"prefix": "/nowhere/private", "owner": "Someone", "private": True}]))
    tmp = tmp_path / "hive-code"
    tmp.mkdir()
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    seen = []

    def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"path": request.url.path, "ok": True})

    app.state.hive.code.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    # the (mocked) service has editable copies of the targets these tests open, as its config would register them
    app.state.hive.code.repos = {"platform": {"path": str(app.state.hive.code.platform_root)},
                                 "program:contract-fixture": {"path": str(app.state.hive.code.platform_root)}}
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        client.admin = {"Authorization": "Bearer " + client.post("/api/auth/login", json={"password": "pw"}).json()["token"]}
        client.seen = seen
        enrol = client.post("/api/services/enrol", json={"name": "omegacode"}, headers=client.admin).json()
        client.reg = client.post("/api/services/register", json={"name": "omegacode", "address": "http://127.0.0.1:8724"},
                                 headers={"Authorization": f"Bearer {enrol['enrol_token']}"}).json()
        yield client


def test_targets_list_what_runs(c):
    c.post("/api/agents", json={"name": "Vega", "kind": "omega", "model": "mock/echo"}, headers=c.admin)
    c.post("/api/agents", json={"name": "Ext", "kind": "module", "model": "mock/echo"}, headers=c.admin)
    targets = {t["id"]: t for t in c.get("/api/code/targets", headers=c.admin).json()}
    assert targets["platform"]["repo"]["commit"] and targets["platform"]["kind"] == "hive"
    assert targets["program:contract-fixture"]["apply"]["how"] == "reload"
    assert any(t["kind"] == "mind" and t["label"] == "Vega" and t["owner"] == targets["platform"]["owner"] for t in targets.values())
    assert targets["service:omegacode"]["kind"] == "service"
    assert not any(t["kind"] == "mind" and t["label"] == "Ext" for t in targets.values())
    tree = c.get("/api/code/targets/program:contract-fixture/tree", headers=c.admin).json()
    assert any(f.endswith("plugin.json") for f in tree["files"]) and tree["commit"] == targets["program:contract-fixture"]["repo"]["commit"]


def test_open_and_relay(c):
    opened = c.post("/api/code/open", json={"target": "program:contract-fixture"}, headers=c.admin).json()
    assert opened["task_id"].startswith("g_") and opened["grant_id"].startswith("gr_")
    q = f"task_id={opened['task_id']}&grant_id={opened['grant_id']}&repository_id={opened['repository_id']}"
    r = c.post(f"/api/code/proxy/v1/workspaces?{q}", json={"operation_id": "create-1", "repository_id": opened["repository_id"],
                                                            "task_id": opened["task_id"], "base_commit": opened["base_commit"]}, headers=c.admin)
    assert r.status_code == 200 and r.json()["path"] == "/v1/workspaces"
    sent = c.seen[-1]
    token = sent.headers["authorization"].split(" ", 1)[1]
    assert token.startswith("hc1.") and "task_id" not in str(sent.url) and "grant_id" not in str(sent.url)
    assert json.loads(sent.content)["operation_id"] == "create-1"
    discovered = c.get(f"/api/code/proxy/v1/tasks/{opened['task_id']}/workspaces?{q}", headers=c.admin)
    assert discovered.status_code == 200 and discovered.json()['path'] == f"/v1/tasks/{opened['task_id']}/workspaces"
    before = len(c.seen)
    refused = c.get(f"/api/code/proxy/v1/tasks/g_foreign/workspaces?{q}", headers=c.admin)
    assert refused.status_code == 403 and refused.json()['error']['code'] == 'task_mismatch'
    assert len(c.seen) == before
    assert c.post(f"/api/code/proxy/v1/tasks/{opened['task_id']}/workspaces?{q}", headers=c.admin).status_code == 404
    # only allow-listed routes are relayed, never operator routes
    assert c.post(f"/api/code/proxy/v1/operator/grants?{q}", json={}, headers=c.admin).json()["error"]["code"] == "not_relayed"
    assert c.get(f"/api/code/proxy/v1/workspaces/../operator?{q}", headers=c.admin).status_code in (400, 404)
    # merge-review forwards every verification_id and refuses any other key, before reaching the service (r11)
    mr = f"/api/code/proxy/v1/workspaces/ws_1/merge-review/ch_1?{q}"
    assert c.get(mr + "&verification_id=v1&verification_id=v2", headers=c.admin).status_code == 200
    assert c.seen[-1].url.params.get_list("verification_id") == ["v1", "v2"]
    # an unlisted route keeps the old one-value-per-key behaviour end to end (Kimi r11 finding 2)
    assert c.get(f"/api/code/proxy/v1/workspaces/ws_1/files?{q}&path=a&path=b", headers=c.admin).status_code == 200
    assert c.seen[-1].url.params.get_list("path") == ["b"]
    before = len(c.seen)
    bad = c.get(mr + "&verification_id=v1&approve=1", headers=c.admin)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "query_not_allowed" and len(c.seen) == before
    # a withdrawn grant stops the relay
    c.delete(f"/api/goals/{opened['task_id']}/grants/{opened['grant_id']}", headers=c.admin)
    assert c.get(f"/api/code/proxy/v1/events?{q}&workspace_id=ws_1", headers=c.admin).json()["error"]["code"] == "grant_invalid"
    # not without sign-in
    assert c.get("/api/code/targets").status_code == 401


def test_private_targets_need_their_owners_agreement(c, monkeypatch):
    app_code = c.app.state.hive.code
    root = str(app_code.platform_root)
    app_code.owners = [{"prefix": root + "/hive/plugins/contract_fixture", "owner": "Codex Example", "private": True}]
    t = {x["id"]: x for x in c.get("/api/code/targets", headers=c.admin).json()}["program:contract-fixture"]
    assert t["private"] and t["owner"] == "Codex Example" and t["openable"] is False
    for r in (c.get("/api/code/targets/program:contract-fixture/tree", headers=c.admin),
              c.post("/api/code/open", json={"target": "program:contract-fixture"}, headers=c.admin)):
        assert r.status_code == 403 and r.json()["error"]["code"] == "private_target"
    app_code.allow_private = {"program:contract-fixture"}
    assert c.post("/api/code/open", json={"target": "program:contract-fixture"}, headers=c.admin).status_code == 200


def test_registered_repositories_for_minds_and_the_workbench(c, tmp_path):
    import subprocess
    repo = tmp_path / "synthetic"
    repo.mkdir()
    (repo / "calc.py").write_text("x = 1\n")
    for args in (["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    c.app.state.hive.code.repos = {"synthetic": {"path": str(repo), "label": "Synthetic calculator"}}
    target = {t["id"]: t for t in c.get("/api/code/targets", headers=c.admin).json()}["repo:synthetic"]
    assert target["kind"] == "repository" and target["openable"] and target["repository_id"] == "synthetic"
    mind = c.post("/api/agents", json={"name": "Coder", "kind": "omega", "model": "mock/echo"}, headers=c.admin).json()
    listed = c.get("/api/agent/code/repositories", headers={"Authorization": f"Bearer {mind['token']}"}).json()
    assert listed == [{"id": "synthetic", "label": "Synthetic calculator", "commit": target["repo"]["commit"]}]
    assert c.get("/api/agent/code/repositories").status_code == 401


def test_attach_existing_workspace_keeps_goal_and_binds_grant(c):
    code = c.app.state.hive.code
    code.repos = {"synthetic": {"path": str(code.platform_root)}}
    opened = c.post('/api/code/open', headers=c.admin, json={"target":"repo:synthetic"}).json()
    goal = c.app.state.hive.goals.get(opened['task_id'])
    count = c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM goals')['n']
    workspace = {"id":"ws_shared", "task_id":goal['id'], "swarm_id":goal['swarm_id'],
                 "repository_id":"synthetic", "base_commit":opened['base_commit'], "generation":2}
    seen = []
    def upstream(request):
        seen.append(request)
        return httpx.Response(200, json=workspace)
    code.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    payload = {"task_id":goal['id'], "workspace_id":workspace['id'], "repository_id":"synthetic"}
    attached = c.post('/api/code/attach', headers=c.admin, json=payload)
    assert attached.status_code == 200, attached.text
    result = attached.json()
    assert result['task_id'] == goal['id'] and result['workspace_id'] == workspace['id']
    assert c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM goals')['n'] == count
    grant = next(g for g in c.app.state.hive.services.grants(goal['id']) if g['id'] == result['grant_id'])
    assert grant['workspace_id'] == workspace['id'] and grant['active']
    # Cache scope includes the grant, rather than borrowing another collaborator's authority.
    # (Since next7 the key also carries the route's exact action set.)
    assert any(k[:4] == ("user:operator", goal['id'], 'synthetic', result['grant_id']) for k in code._caps)
    for field in ('task_id', 'swarm_id', 'repository_id', 'id'):
        original = workspace[field]
        workspace[field] = 'different'
        rejected = c.post('/api/code/attach', headers=c.admin, json=payload)
        assert rejected.status_code == 403 and rejected.json()['error']['code'] == 'workspace_mismatch'
        workspace[field] = original
    base = workspace.pop('base_commit')
    rejected = c.post('/api/code/attach', headers=c.admin, json=payload)
    assert rejected.status_code == 502 and rejected.json()['error']['code'] == 'workspace_invalid'
    workspace['base_commit'] = base
    assert sum(g['active'] for g in c.app.state.hive.services.grants(goal['id'])) == 2
    assert c.post('/api/code/attach', json=payload).status_code == 401
    c.app.state.hive.db.execute("UPDATE goals SET status='done' WHERE id=?", (goal['id'],))
    assert c.post('/api/code/attach', headers=c.admin, json=payload).status_code == 409


def test_select_target_keeps_the_exact_task_and_never_mutates_it(c):
    hive = c.app.state.hive
    code = hive.code
    code.repos = {"synthetic": {"path": str(code.platform_root)}}
    swarm = code.code_swarm()
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (c.post('/api/code/open', headers=c.admin, json={"target": "repo:synthetic"}).json()['task_id'],))
    # a reserved goal with no target binding and no workspace
    import asyncio
    reserved = asyncio.run(hive.goals.create(swarm['id'], 'Reserved acceptance', 'no binding'))
    before = dict(hive.db.one("SELECT * FROM goals WHERE id = ?", (reserved['id'],)))
    count = hive.db.one('SELECT COUNT(*) AS n FROM goals')['n']
    ok = c.post('/api/code/select', headers=c.admin, json={"task_id": reserved['id'], "repository_id": "synthetic"})
    assert ok.status_code == 200, ok.text
    got = ok.json()
    assert got['task_id'] == reserved['id'] and got['swarm_id'] == swarm['id'] and got['repository_id'] == 'synthetic' and got['base_commit']
    assert 'workspace_id' not in got
    assert dict(hive.db.one("SELECT * FROM goals WHERE id = ?", (reserved['id'],))) == before   # the goal itself is untouched
    assert hive.db.one('SELECT COUNT(*) AS n FROM goals')['n'] == count
    grant = next(g for g in hive.services.grants(reserved['id']) if g['id'] == got['grant_id'])
    assert grant['active'] and grant['scope'] == 'edit' and grant['workspace_id'] is None
    # refusals: unauthenticated, unknown task, unregistered repository, closed task
    assert c.post('/api/code/select', json={"task_id": reserved['id'], "repository_id": "synthetic"}).status_code == 401
    assert c.post('/api/code/select', headers=c.admin, json={"task_id": "g_nope", "repository_id": "synthetic"}).status_code == 404
    assert c.post('/api/code/select', headers=c.admin, json={"task_id": reserved['id'], "repository_id": "other"}).status_code == 403
    assert c.post('/api/code/select', headers=c.admin, json={"task_id": "../x", "repository_id": "synthetic"}).status_code == 400
    hive.db.execute("UPDATE goals SET status='done' WHERE id=?", (goal['id'],))
    assert c.post('/api/code/select', headers=c.admin, json={"task_id": goal['id'], "repository_id": "synthetic"}).status_code == 409


def test_relay_supports_tree_recovery_and_runtime_routes(c):
    opened = c.post('/api/code/open', json={"target":"program:contract-fixture"}, headers=c.admin).json()
    q = f"task_id={opened['task_id']}&grant_id={opened['grant_id']}&repository_id={opened['repository_id']}"
    for method,path in [('GET','/v1/workspaces/ws_1/tree'),('GET','/v1/workspaces/ws_1/toolchains'),
                        ('GET','/v1/workspaces/ws_1/checkpoints'),('POST','/v1/workspaces/ws_1/restores')]:
        response = c.request(method, '/api/code/proxy'+path+'?'+q, headers=c.admin)
        assert response.status_code == 200, response.text


def test_operator_command_prefixes_are_not_chosen_by_browser(c):
    import base64
    code = c.app.state.hive.code
    code.repos = {'synthetic': {'path': str(code.platform_root), 'argv_prefixes': [['python3', '-m', 'pytest']]}}
    opened = c.post('/api/code/open', headers=c.admin, json={'target':'repo:synthetic'}).json()
    q = {'task_id':opened['task_id'], 'grant_id':opened['grant_id'], 'repository_id':'synthetic', 'argv_prefixes':'[["sh"]]'}
    assert c.get('/api/code/proxy/v1/workspaces/ws_1', headers=c.admin, params=q).status_code == 200
    encoded = c.seen[-1].headers['authorization'].split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
    assert claims['argv_prefixes'] == [['python3','-m','pytest']]
    code._caps.clear()
    code.repos['synthetic']['argv_prefixes'] = [[]]
    assert c.get('/api/code/proxy/v1/workspaces/ws_1', headers=c.admin, params=q).status_code == 503


def test_scoped_binary_output_artifact_relay(c):
    import base64
    opened = c.post('/api/code/open', headers=c.admin, json={'target':'program:contract-fixture'}).json()
    q = {'task_id':opened['task_id'], 'grant_id':opened['grant_id'], 'repository_id':opened['repository_id'], 'workspace_id':'ws_1'}
    data = 'Synthetic output: λ\n'.encode()
    c.app.state.hive.code.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=data)))
    response = c.get('/api/code/proxy/v1/artifacts/'+'a'*64, headers=c.admin, params=q)
    assert response.status_code == 200 and response.headers['content-type'].startswith('application/json')
    assert base64.b64decode(response.json()['content_base64']) == data
    assert response.json()['size_bytes'] == len(data)
    assert c.get('/api/code/proxy/v1/artifacts/not-a-digest', headers=c.admin, params=q).status_code == 404
    c.delete('/api/goals/'+opened['task_id']+'/grants/'+opened['grant_id'], headers=c.admin)
    assert c.get('/api/code/proxy/v1/artifacts/'+'a'*64, headers=c.admin, params=q).status_code == 403


def test_evidence_routes_relay_exact_query_without_widening_allowlist(c):
    opened = c.post('/api/code/open', json={'target': 'program:contract-fixture'}, headers=c.admin).json()
    binding = {'task_id': opened['task_id'], 'grant_id': opened['grant_id'], 'repository_id': opened['repository_id']}
    for path, query in [('/v1/workspaces/ws_one/runs', {'limit': '10', 'cursor': 'opaque'}),
                        ('/v1/workspaces/ws_one/verifications', {'limit': '10'}),
                        ('/v1/workspaces/ws_one/diagnostics', {'path': 'x.metta', 'generation': '3'}),
                        ('/v1/runs/run_one/output', {'after': '1024', 'limit': '16384'})]:
        result = c.get('/api/code/proxy'+path, params={**binding, **query}, headers=c.admin)
        assert result.status_code == 200 and result.json()['path'] == path
        assert dict(c.seen[-1].url.params) == query
    for method, path in [('POST', '/v1/runs/run_one/output'), ('GET', '/v1/operator/grants'),
                         ('GET', '/v1/workspaces/ws_one/runs/extra'), ('GET', '/v1/runs/run_one/output/extra')]:
        result = c.request(method, '/api/code/proxy'+path, params=binding, headers=c.admin)
        assert result.status_code == 404
    c.delete(f"/api/goals/{opened['task_id']}/grants/{opened['grant_id']}", headers=c.admin)
    refused = c.get('/api/code/proxy/v1/runs/run_one/output', params=binding, headers=c.admin)
    assert refused.status_code == 403


def test_retrieval_and_proof_proxy_routes_are_narrow_and_revoke(c):
    opened=c.post('/api/code/open',json={'target':'program:contract-fixture'},headers=c.admin).json()
    binding={'task_id':opened['task_id'],'grant_id':opened['grant_id'],'repository_id':opened['repository_id']}
    for method,path in [('POST','/v1/workspaces/ws_one/repository-facts'),
                        ('POST','/v1/workspaces/ws_one/repository-retrieval'),
                        ('GET','/v1/runs/run_one/proof-result')]:
        assert c.request(method,'/api/code/proxy'+path,params=binding,headers=c.admin,json={} if method=='POST' else None).status_code==200
    for method,path in [('GET','/v1/workspaces/ws_one/repository-retrieval'),
                        ('POST','/v1/runs/run_one/proof-result'),('GET','/v1/runs/run_one/proof-result/extra'),
                        ('POST','/v1/workspaces/ws_one/repository-retrieval/extra')]:
        assert c.request(method,'/api/code/proxy'+path,params=binding,headers=c.admin).status_code==404
    c.delete(f"/api/goals/{opened['task_id']}/grants/{opened['grant_id']}",headers=c.admin)
    assert c.get('/api/code/proxy/v1/runs/run_one/proof-result',params=binding,headers=c.admin).status_code==403


def test_a_target_the_service_cannot_edit_is_not_offered_and_never_half_opens(c):
    """Jon 2026-10-05: 'I've NEVER seen workspace'. The hive offered targets the service has no editable copy of; opening
    one created a task and grant, then the service refused with 403 repository_unregistered."""
    code = c.app.state.hive.code
    code.repos = {"platform": {"path": str(code.platform_root)}}                 # only the platform copy is registered
    targets = {t["id"]: t for t in c.get("/api/code/targets", headers=c.admin).json()}
    fixture = targets["program:contract-fixture"]
    assert fixture["openable"] is False and "no editable copy" in fixture["closed_reason"]
    assert targets["platform"]["openable"] is True and targets["platform"]["closed_reason"] is None
    goals = c.app.state.hive.db.one("SELECT COUNT(*) AS n FROM goals")["n"]
    r = c.post("/api/code/open", json={"target": "program:contract-fixture"}, headers=c.admin)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_editable"
    assert c.app.state.hive.db.one("SELECT COUNT(*) AS n FROM goals")["n"] == goals          # nothing half-created


def test_the_service_config_is_the_one_source_of_editable_repositories(monkeypatch, tmp_path):
    from hive.core.code import Code
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"repositories": {"synthetic": {"path": "/r/s"}, "synthetic-metta": {"path": "/r/m"}}}))
    monkeypatch.setenv("HIVE_CODE_SERVICE_CONFIG", str(cfg))
    monkeypatch.setenv("HIVE_CODE_REPOS", json.dumps({"synthetic": {"label": "Calculator", "path": "/stale"},
                                                      "gone": {"path": "/x"}}))
    assert Code._service_repositories() == {"synthetic": "/r/s", "synthetic-metta": "/r/m"}
    monkeypatch.setenv("HIVE_CODE_SERVICE_CONFIG", str(tmp_path / "missing.json"))
    assert Code._service_repositories() == {}                                       # named but unreadable: nothing


def test_every_code_authority_point_refuses_a_mismatched_service_release(c, monkeypatch):
    """Kimi next15: open, attach, select_target and both capability routes mint Code authority; all must check the release."""
    from hive.core.code import Code
    monkeypatch.setattr(Code, "_loaded_release_mismatch", lambda self: "configured release 00000000")
    code = c.app.state.hive.code
    code.repos = {"synthetic": {"path": str(code.platform_root)}}
    r = c.post("/api/code/open", json={"target": "repo:synthetic"}, headers=c.admin)
    assert r.status_code == 503 and r.json()["error"]["code"] == "service_release_mismatch"
    r = c.post("/api/code/capability", json={"task_id": "g_x", "repository_id": "synthetic"}, headers=c.admin)
    assert r.status_code == 503 and r.json()["error"]["code"] == "service_release_mismatch"
    import asyncio, pytest
    from hive.core.code import CodeError
    for call in (lambda: asyncio.run(code.attach("g_x", "ws_x", "synthetic", "user:operator")),
                 lambda: code.select_target("g_x", "synthetic", "user:operator")):
        with pytest.raises(CodeError) as e:
            call()
        assert e.value.code == "service_release_mismatch"
