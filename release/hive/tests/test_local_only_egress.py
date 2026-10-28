import asyncio
import json
import httpx
import pytest
from hive.core.config import Provider
from hive.core.gateway import Gateway, GatewayError
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers


@pytest.mark.parametrize('route,local', [('https://remote.invalid/v1', False),
    ('https://remote.invalid/v1', True), ('http://localhost:11434/v1', True),
    ('http://127.0.0.1:11434/v1?redirect=remote', True),
    ('http://user:secret@127.0.0.1:11434/v1', True)])
@pytest.mark.parametrize('operation', ['chat', 'embeddings'])
def test_remote_or_ambiguous_routes_denied_before_network(monkeypatch, route, local, operation):
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', '["private-swarm"]')
    async def run():
        gate = Gateway({'model': Provider('model', base_url=route, local=local)})
        calls = []
        async def capture(request):
            calls.append(request)
            return httpx.Response(200, json={})
        await gate.client.aclose()
        gate.client = httpx.AsyncClient(transport=httpx.MockTransport(capture))
        agent = {'name': 'invented', 'model': 'model/test', 'swarm_id': 'private-swarm'}
        try:
            with pytest.raises(GatewayError) as refusal:
                if operation == 'chat':
                    await gate.chat(agent, {'messages': [{'role': 'user', 'content': 'invented canary'}]})
                else:
                    await gate.embeddings('model/test', {'input': 'invented canary'}, agent=agent)
            assert refusal.value.code == 'egress_refused'
            assert calls == []
        finally:
            await gate.client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize('route', ['http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1'])
def test_explicit_local_route_allowed(monkeypatch, route):
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', '["private-swarm"]')
    async def run():
        gate = Gateway({'local': Provider('local', base_url=route, local=True)})
        try:
            gate.enforce_egress({'swarm_id': 'private-swarm'}, 'local')
        finally:
            await gate.client.aclose()
    asyncio.run(run())


@pytest.mark.parametrize('raw', ['broken', '{}', '[null]'])
def test_bad_policy_fails_closed(monkeypatch, raw):
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', raw)
    async def run():
        gate = Gateway({})
        try:
            with pytest.raises(GatewayError):
                gate.enforce_egress({'swarm_id': 'private-swarm'}, 'mock')
        finally:
            await gate.client.aclose()
    asyncio.run(run())


def test_missing_embedding_identity_cannot_bypass_policy(monkeypatch):
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', '["private-swarm"]')
    async def run():
        gate = Gateway({})
        try:
            with pytest.raises(GatewayError, match='identity'):
                await gate.embeddings('mock/embed', {'input': 'invented canary'})
        finally:
            await gate.client.aclose()
    asyncio.run(run())


def test_embeddings_route_passes_authenticated_agent_not_body_identity(client, monkeypatch):
    swarm, agents = make_swarm_and_agents(client, n=1)
    observed = []
    async def capture(model, body, agent=None):
        observed.append(agent)
        return {'data': []}
    monkeypatch.setattr(client.app.state.gateway, 'embeddings', capture)
    response = client.post('/llm/v1/embeddings', headers=agent_headers(agents[0]),
        json={'input': 'invented canary', 'swarm_id': 'spoofed-unprotected-swarm'})
    assert response.status_code == 200
    assert observed[0]['id'] == agents[0]['id']
    assert observed[0]['swarm_id'] == swarm['id']


@pytest.mark.parametrize('endpoint', ['chat/completions', 'embeddings'])
def test_authenticated_http_protected_swarm_cannot_send_canary_remotely(client, monkeypatch, endpoint):
    swarm, agents = make_swarm_and_agents(client, n=1)
    hive, gate = client.app.state.hive, client.app.state.gateway
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', json.dumps([swarm['id']]))
    gate.providers['remote'] = Provider('remote', base_url='https://remote.invalid/v1',
        prices={'*': {'in': 1, 'out': 1}})
    hive.db.update('agents', agents[0]['id'], {'model': 'remote/test'})
    monkeypatch.setattr(hive.settings, 'embedding_model', 'remote/embed')
    async def forbidden(*args, **kwargs):
        pytest.fail('Protected canary reached outbound HTTP')
    monkeypatch.setattr(gate.client, 'post', forbidden)
    body = {'messages': [{'role': 'user', 'content': 'invented canary'}]} if endpoint == 'chat/completions' else {'input': 'invented canary'}
    body.update(swarm_id='spoofed-unprotected-swarm', model='mock/echo')
    response = client.post('/llm/v1/' + endpoint, headers=agent_headers(agents[0]), json=body)
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'egress_refused'
    assert 'invented canary' not in response.text


def test_protected_model_switch_keeps_same_egress_restriction(client, monkeypatch):
    swarm, agents = make_swarm_and_agents(client, n=1)
    hive, gate = client.app.state.hive, client.app.state.gateway
    monkeypatch.setenv('HIVE_LOCAL_ONLY_SWARMS', json.dumps([swarm['id']]))
    gate.providers['remote'] = Provider('remote', base_url='https://remote.invalid/v1')
    good = client.post('/llm/v1/chat/completions', headers=agent_headers(agents[0]),
        json={'messages': [{'role': 'user', 'content': 'HUMAN-MSG: invented canary'}]})
    assert good.status_code == 200
    hive.db.update('agents', agents[0]['id'], {'model': 'remote/changed'})
    async def forbidden(*args, **kwargs):
        pytest.fail('Model switch bypassed local-only restriction')
    monkeypatch.setattr(gate.client, 'post', forbidden)
    denied = client.post('/llm/v1/chat/completions', headers=agent_headers(agents[0]),
        json={'messages': [{'role': 'user', 'content': 'remembered invented canary'}]})
    assert denied.status_code == 403
    assert denied.json()['error']['code'] == 'egress_refused'
