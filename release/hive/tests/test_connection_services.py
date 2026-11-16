from hive.tests.test_connections import client, setup, agreement, call


def test_private_service_discovery_and_expiry(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    path = f"/api/swarms/{A['id']}/services"
    assert client.put(path, json={"kinds": ["public"], "connection_only_kinds": ["match"]}).status_code == 200
    assert client.get(path).json()["kinds"] == ["public"]
    agent_path = f"/api/agent/services/{A['id']}"
    assert call(client, b, "GET", agent_path).json()["kinds"] == ["public"]
    assert call(client, a, "GET", agent_path).json()["kinds"] == ["match", "public"]
    scopes = [{"kind": "requests", "direction": "to->from", "kinds": ["match"]}]
    c = client.post('/api/connections', json=agreement(A, B, a, b, scopes=scopes)).json()
    assert call(client, b, "GET", agent_path).json()["kinds"] == ["match", "public"]
    assert hive.agreements.allows_request(B['id'], A['id'], 'match')
    assert not hive.agreements.allows_request(A['id'], B['id'], 'match')
    hive.db.update('connections', c['id'], {'ends_at': '2000-01-01T00:00:00.000Z'})
    assert call(client, b, "GET", agent_path).json()["kinds"] == ["public"]
    assert not hive.agreements.allows_request(B['id'], A['id'], 'match')
    assert client.put(path, json={"kinds": ["match"]}).status_code == 400
    assert client.put(path, json={"kinds": ["public"]}).status_code == 200
    assert hive.collab.connection_services(A['id']) == ['match']


def test_connection_service_requests_need_current_grant(client):
    A, B, a, member, b = setup(client)
    assert client.put(f"/api/swarms/{A['id']}/services", json={"kinds": [], "connection_only_kinds": ["match"]}).status_code == 200
    goal = client.post(f"/api/swarms/{B['id']}/goals", json={"title": "find ability", "assignee": b['name']}).json()
    assert call(client, b, 'POST', f"/api/agent/goals/{goal['id']}/claim").status_code == 200
    ask = {'kind': 'match', 'to_swarm': A['id'], 'from_goal': goal['id'], 'title': 'match', 'budget_usd': 0}
    assert call(client, b, 'POST', '/api/agent/requests', ask).status_code == 403
    c = client.post('/api/connections', json=agreement(A, B, a, b, scopes=[{'kind': 'requests', 'direction': 'to->from', 'kinds': ['match']}])).json()
    response = call(client, b, 'POST', '/api/agent/requests', ask)
    assert response.status_code == 200, response.text
    assert response.json()['connection_id'] == c['id']
    client.post(f"/api/connections/{c['id']}/revoke", json={'reason': 'complete'})
    assert call(client, b, 'POST', '/api/agent/requests', ask).status_code == 403
    assert client.put(f"/api/swarms/{A['id']}/services", json={'kinds': [], 'connection_only_kinds': 'match'}).status_code == 400


def test_catalogue_uses_authenticated_swarm_and_only_advertised_evidence(client):
    A, B, a, member, b = setup(client)
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['public'], 'connection_only_kinds': ['match']})
    path = f"/api/agent/service-catalogue?requester_swarm={A['id']}"
    before = call(client, b, 'GET', path).json()
    assert before['requester_swarm'] == B['id']
    assert [o['service'] for o in before['offers']] == ['public']
    client.post('/api/connections', json=agreement(A, B, a, b, scopes=[{'kind': 'requests', 'direction': 'to->from', 'kinds': ['match']}]))
    after = call(client, b, 'GET', path).json()
    assert [o['service'] for o in after['offers']] == ['match', 'public']
    assert before['digest'] != after['digest']
    assert all(o['evidence_tier'] == 'advertised' and 'performance' in o['unknowns'] for o in after['offers'])


def test_catalogue_connection_does_not_override_provider_visibility(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:alice', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': 'user:bob'})
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['public'], 'connection_only_kinds': ['match']})
    client.post('/api/connections', json=agreement(A, B, a, b, scopes=[{'kind': 'requests', 'direction': 'to->from', 'kinds': ['match']}]))
    path = '/api/agent/service-catalogue'
    assert call(client, b, 'GET', path).json()['offers'] == []
    assert call(client, b, 'GET', f"/api/agent/services/{A['id']}").json()['kinds'] == []
    hive.db.update('swarms', A['id'], {'visibility': 'shared', 'shared_with': '["user:bob"]'})
    seen = call(client, b, 'GET', path).json()
    assert [o['service'] for o in seen['offers']] == ['match', 'public']
    hive.db.update('swarms', A['id'], {'shared_with': '[]'})
    assert call(client, b, 'GET', path).json()['offers'] == []


def test_missing_requester_owner_never_inherits_operator_visibility(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:operator', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': None})
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['review']})
    assert call(client, b, 'GET', '/api/agent/service-catalogue').json()['offers'] == []


def test_capability_projection_digest_stability_and_partial_evidence(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:alice', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': 'user:bob'})
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['hidden']})
    before = hive.collab.capability_catalogue(B['id'])
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['other-hidden']})
    assert hive.collab.capability_catalogue(B['id'])['catalogue_digest'] == before['catalogue_digest']
    hive.db.update('swarms', A['id'], {'visibility': 'public'})
    after = hive.collab.capability_catalogue(B['id'])
    assert after['catalogue_digest'] != before['catalogue_digest']
    assert hive.collab.capability_catalogue(B['id'])['catalogue_digest'] == after['catalogue_digest']
    assert after['truncated'] is True and after['sources']['roles'].startswith('sha256:')
    assert after['offers'][0]['tier'] == 'advertised'
    assert after['offers'][0]['evidence'][0]['kind'] == 'config'



def test_role_projection_requires_agent_and_swarm_visibility_and_tracks_revision(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:alice', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': 'user:bob'})
    hive.db.update('agents', a['id'], {'owner': 'user:alice', 'visibility': 'private'})
    role = client.post('/api/roles', json={'name': 'Synthetic media role', 'prompt': 'synthetic',
                                         'media': ['deck'], 'mandate': {'id': 'synthetic-review', 'version': '1'}}).json()
    hive.db.update('agents', a['id'], {'role_id': role['id']})
    before = hive.collab.capability_catalogue(B['id'])
    assert not any(o['provider']['id'] == a['id'] for o in before['offers'])
    client.patch(f"/api/roles/{role['id']}", json={'prompt': 'changed synthetic prompt'})
    assert hive.collab.capability_catalogue(B['id'])['catalogue_digest'] == before['catalogue_digest']
    hive.db.update('swarms', A['id'], {'visibility': 'public'})
    assert not any(o['provider']['id'] == a['id'] for o in hive.collab.capability_catalogue(B['id'])['offers'])
    hive.db.update('agents', a['id'], {'visibility': 'public'})
    visible = hive.collab.capability_catalogue(B['id'])
    offers = [o for o in visible['offers'] if o['provider']['id'] == a['id']]
    assert {(o['capability']['source'], o['capability']['name']) for o in offers} == {('role.media', 'deck'), ('role.mandate', 'synthetic-review')}
    assert all(o['tier'] == 'advertised' and 'performance' in o['unknowns'] for o in offers)
    client.patch(f"/api/roles/{role['id']}", json={'mandate': {'id': 'synthetic-review', 'version': '2'}})
    changed = hive.collab.capability_catalogue(B['id'])
    assert changed['catalogue_digest'] != visible['catalogue_digest']
    hive.db.update('agents', a['id'], {'deleted': 1})
    assert not any(o['provider']['id'] == a['id'] for o in hive.collab.capability_catalogue(B['id'])['offers'])



def test_catalogue_endpoint_binds_agent_scope_and_does_not_inherit_admin_sight(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:alice', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': 'user:bob'})
    client.put(f"/api/swarms/{A['id']}/services", json={'kinds': ['hidden-service']})
    path = '/api/match/catalogue'
    agent_view = call(client, b, 'GET', path)
    assert agent_view.status_code == 200
    assert agent_view.json()['requester_swarm'] == B['id']
    assert not any(o['provider']['id'] == A['id'] for o in agent_view.json()['offers'])
    assert call(client, b, 'GET', path + f"?scope={A['id']}").status_code == 403
    admin_view = client.get(path + f"?scope={B['id']}")
    assert admin_view.status_code == 200
    assert admin_view.json()['catalogue_digest'] == agent_view.json()['catalogue_digest']
    assert client.get(path).status_code == 400
    assert client.get(path + '?scope=missing').status_code == 404
    assert client.get(path, headers={'authorization': 'Bearer invalid'}).status_code == 401
    lone = client.post('/api/agents', json={'name': 'Synthetic unattached', 'kind': 'module'}).json()
    assert call(client, lone, 'GET', path).status_code == 403



def test_person_cannot_borrow_shared_requester_owners_visibility(client):
    from hive.tests.test_visibility import person
    ann = person(client, 'u_catalogue_ann')
    bob = person(client, 'u_catalogue_bob')
    swarm = client.post('/api/swarms', headers=ann, json={'name': 'Synthetic requester'}).json()
    client.put(f"/api/swarms/{swarm['id']}/visibility", headers=ann,
               json={'visibility': 'shared', 'shared_with': ['user:u_catalogue_bob']})
    path = f"/api/match/catalogue?scope={swarm['id']}"
    assert client.get(f"/api/swarms/{swarm['id']}", headers=bob).status_code == 200
    assert client.get(path, headers=bob).status_code == 404
    assert client.get(path, headers=ann).status_code == 200
    assert client.get(path).status_code == 200



def test_program_actions_require_visible_activation_and_enabled_registry(client):
    A, B, a, member, b = setup(client)
    hive = client.app.state.hive
    hive.db.update('swarms', A['id'], {'owner': 'user:alice', 'visibility': 'private'})
    hive.db.update('swarms', B['id'], {'owner': 'user:bob'})
    hive.programs.programs['synthetic-app'] = {'id': 'synthetic-app', 'error': None, 'digest': 'sha256:synthetic-v1',
                                           'describe': {'actions': [{'id': 'synthetic-action'}]}}
    def app_offers():
        return [o for o in hive.collab.capability_catalogue(B['id'])['offers'] if o['provider']['kind'] == 'program']
    assert app_offers() == []
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, ?, ?)", ('synthetic-app', A['id'], 1, 'user:alice'))
    assert app_offers() == []
    hive.db.update('swarms', A['id'], {'visibility': 'public'})
    offers = app_offers()
    assert len(offers) == 1 and offers[0]['tier'] == 'advertised'
    assert 'action-authorization' in offers[0]['unknowns']
    before = hive.collab.capability_catalogue(B['id'])['catalogue_digest']
    hive.programs.programs['synthetic-app']['digest'] = 'sha256:synthetic-v2'
    assert hive.collab.capability_catalogue(B['id'])['catalogue_digest'] != before
    hive.programs.disabled.add('synthetic-app')
    assert app_offers() == []
    hive.programs.disabled.remove('synthetic-app')
    hive.db.execute("UPDATE app_activations SET active=0 WHERE program=?", ('synthetic-app',))
    assert app_offers() == []
    assert not any(call[0] == 'start' for call in client.supervisor.calls)
