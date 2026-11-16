"""Cached content must not bypass current policy or app authorization."""
import json
from hive.tests.test_program_actions import setup, act
from hive.tests.test_core_api import client


def test_cached_action_is_refused_after_policy_denial(client, tmp_path, monkeypatch):
    _, agent, _ = setup(client, tmp_path, monkeypatch)
    rule = client.post('/api/policy', json={'scope': f"agent:{agent['id']}",
        'skill': 'program:social:post', 'mode': 'allow'}).json()
    body = dict(action='post', items=['p1'], params={}, idempotency_key='cached')
    assert act(client, agent, **body).status_code == 200
    client.delete(f"/api/policy/{rule['id']}")
    client.post('/api/policy', json={'scope': f"agent:{agent['id']}",
        'skill': 'program:social:post', 'mode': 'deny'})
    response = act(client, agent, **body)
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'policy_refused'


def test_sensitive_retry_rechecks_app_and_preserves_original_record(client, tmp_path, monkeypatch):
    _, agent, _ = setup(client, tmp_path, monkeypatch)
    entry = client.app.state.hive.programs._ready('social')
    entry['describe']['actions'][0]['revalidate'] = True
    module = entry['module']
    allowed = [True]
    async def sensitive(ctx, action, items, params):
        if not allowed[0]:
            return {'status': 'refused', 'message': 'Grant withdrawn'}
        return {'status': 'done', 'detail': {'snapshot': 'synthetic canary'}}
    monkeypatch.setattr(module, 'act', sensitive)
    client.post('/api/policy', json={'scope': f"agent:{agent['id']}",
        'skill': 'program:social:post', 'mode': 'allow'})
    body = dict(action='post', items=['p1'], params={}, idempotency_key='sensitive')
    assert act(client, agent, **body).json()['detail']['snapshot'] == 'synthetic canary'
    hive = client.app.state.hive
    original = hive.db.one('SELECT result FROM program_actions WHERE idempotency_key=?', ('sensitive',))['result']
    allowed[0] = False
    reply = act(client, agent, **body).json()
    assert reply['status'] == 'refused' and 'detail' not in reply
    assert hive.db.one('SELECT result FROM program_actions WHERE idempotency_key=?', ('sensitive',))['result'] == original


def test_recovering_an_approved_sensitive_effect_needs_no_second_approval(client, tmp_path, monkeypatch):
    _, agent, _ = setup(client, tmp_path, monkeypatch)
    entry = client.app.state.hive.programs._ready('social')
    entry['describe']['actions'][0]['revalidate'] = True
    seen = []
    async def sensitive(ctx, action, items, params):
        seen.append(dict(ctx.actor))
        return {'status': 'done', 'detail': {'receipt': 'synthetic'}}
    monkeypatch.setattr(entry['module'], 'act', sensitive)
    client.post('/api/policy', json={'scope': f"agent:{agent['id']}", 'skill': 'program:social:post', 'mode': 'ask'})
    body = dict(action='post', items=['p1'], params={}, idempotency_key='approved-once')
    pending = act(client, agent, **body).json()
    assert pending['status'] == 'approval_required'
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={})
    assert act(client, agent, **body, approval_id=pending['approval_id']).json()['status'] == 'done'
    again = act(client, agent, **body).json()                       # retry: no approval id, nothing new to approve
    assert again['status'] == 'done' and again['detail']['receipt'] == 'synthetic'
    assert seen[-1]['recovery'] is True and seen[-1]['approval']['id'] == pending['approval_id']
    assert client.get('/api/approvals?status=pending').json() == []   # no second approval filed


def test_recovery_hands_the_app_its_recorded_result(client, tmp_path, monkeypatch):
    _, agent, _ = setup(client, tmp_path, monkeypatch)
    entry = client.app.state.hive.programs._ready('social')
    entry['describe']['actions'][0]['revalidate'] = True
    seen = []
    async def sensitive(ctx, action, items, params):
        seen.append(dict(ctx.command or {}))
        if (ctx.actor or {}).get('recovery'):
            return ctx.command['recorded_result']            # recheck access, then return the original unchanged
        return {'status': 'done', 'detail': {'receipt': 'original-1'}}
    monkeypatch.setattr(entry['module'], 'act', sensitive)
    client.post('/api/policy', json={'scope': f"agent:{agent['id']}", 'skill': 'program:social:post', 'mode': 'allow'})
    body = dict(action='post', items=['p1'], params={}, idempotency_key='rec')
    first = act(client, agent, **body).json()
    again = act(client, agent, **body).json()
    assert first['detail']['receipt'] == 'original-1' and again == first
    assert seen[-1]['recorded_result']['detail']['receipt'] == 'original-1'
