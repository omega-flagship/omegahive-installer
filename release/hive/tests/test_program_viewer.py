"""Trusted read context and body/list visibility, invented people/apps only."""
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_visibility import person
import pytest

from hive.tests.test_app_attachments import ROOT, _needs, setup_app, attach


def test_body_targets_are_checked_before_view_or_action_and_viewer_is_host_derived(client, monkeypatch):
    ann, bob = person(client, "u_view_ann"), person(client, "u_view_bob")
    swarm = client.post('/api/swarms', headers=ann, json={'name': 'Private synthetic app context'}).json()
    module = client.app.state.hive.programs._ready('contract-fixture')['module']
    original_view, original_act = module.view, module.act
    seen, acted = [], []
    def read(ctx, focus, stage):
        seen.append((ctx.viewer, ctx.actor, ctx.command))
        return original_view(ctx, focus, stage)
    def act(ctx, action, items, params):
        acted.append(ctx.actor)
        return original_act(ctx, action, items, params)
    monkeypatch.setattr(module, 'view', read)
    monkeypatch.setattr(module, 'act', act)
    body = {'swarm_id': swarm['id']}
    assert client.post('/api/programs/contract-fixture/view', headers=bob, json=body).status_code == 404
    assert client.post('/api/programs/contract-fixture/act', headers=bob, json=dict(body, action='inspect-source', items=['e1'])).status_code == 404
    assert not seen and not acted
    for field in ('viewer', 'actor', 'principal', 'member_id'):
        assert client.post('/api/programs/contract-fixture/view', headers=ann, json=dict(body, **{field: 'spoof'})).status_code == 400
    good = client.post('/api/programs/contract-fixture/view', headers=ann, json=body)
    assert good.status_code == 200
    who, actor, command = seen[0]
    assert who['principal'] == 'user:u_view_ann' and who['kind'] == 'person'
    assert who['person_id'] == 'u_view_ann' and 'id' not in who
    assert who['swarm_id'] == swarm['id'] and who['local_operator'] is False
    assert who['member_id'] is None and actor is None and command is None


@pytest.mark.skipif(ROOT is None, reason=_needs("omegafusion"))
def test_attachment_list_filters_private_mind_even_in_visible_swarm(client, tmp_path, monkeypatch):
    _, values, data, _ = setup_app(client, tmp_path, monkeypatch)
    swarm, mind = values[:2]
    aid = attach(client, 'omegafusion', data).json()['id']
    bob = person(client, 'u_list_bob')
    hive = client.app.state.hive
    hive.db.update('swarms', swarm['id'], {'visibility': 'public'})
    hive.db.update('agents', mind['id'], {'visibility': 'private'})
    activations = '/api/programs/omegafusion/activations'
    attachments = '/api/programs/omegafusion/attachments'
    assert any(r['swarm_id'] == swarm['id'] for r in client.get(activations, headers=bob).json())
    assert client.get(attachments, headers=bob).json() == []
    hive.db.update('agents', mind['id'], {'visibility': 'shared', 'shared_with': '["user:u_list_bob"]'})
    assert [r['id'] for r in client.get(attachments, headers=bob).json()] == [aid]
    hive.db.update('swarms', swarm['id'], {'visibility': 'private'})
    assert client.get(activations, headers=bob).json() == []
    assert client.get(attachments, headers=bob).json() == []
    # The named admin retains audit visibility, without gaining app-domain membership.
    assert len(client.get(attachments).json()) == 1
