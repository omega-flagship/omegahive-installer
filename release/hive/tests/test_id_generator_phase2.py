"""New identities use 128 random bits; historical rows and workspace authority remain unchanged."""
import re

import pytest

from hive.core.db import new_id

# Intentional noncanonical returns: test_identity_namespace.py::test_legacy_return_needs_outbound_proof_for_this_exact_incoming_manifest (Placement._check_import_identity).
from hive.tests.test_identity_namespace import historical
from hive.tests.test_placement import client, home, mind_in_swarm  # noqa: F401


@pytest.mark.parametrize('prefix', ['a', 's', 'm', 'g', 'r'])
def test_generated_identifiers_request_128_random_bits_from_the_existing_secure_source(monkeypatch, prefix):
    from hive.core import db
    requested = []
    original = db.secrets.token_hex
    def capture(n):
        requested.append(n)
        return original(n)
    monkeypatch.setattr(db.secrets, 'token_hex', capture)
    value = new_id(prefix)
    assert requested == [16]
    assert re.fullmatch(re.escape(prefix) + '_[0-9a-f]{32}', value)


def test_new_128_bit_mind_moves_through_existing_routes_without_rewriting_legacy_identity(client, home):
    swarm, mind = mind_in_swarm(client)
    assert re.fullmatch('s_[0-9a-f]{32}', swarm['id'])
    assert re.fullmatch('a_[0-9a-f]{32}', mind['id'])
    posted = client.post('/api/agents/' + mind['id'] + '/messages', json={'text': 'Invented 128-bit identity message'})
    assert posted.status_code == 200, posted.text
    message = posted.json()
    assert message['agent_id'] == mind['id']
    history = client.get('/api/agents/' + mind['id'] + '/messages').json()
    assert next(row for row in history if row['id'] == message['id'])['agent_id'] == mind['id']
    hive = client.app.state.hive
    assert hive.db.one('SELECT agent_id FROM messages WHERE id=?', (message['id'],))['agent_id'] == mind['id']
    historical(hive, mind['id'], 'a_01234567')
    legacy = hive.db.one('SELECT * FROM agents WHERE id=?', ('a_01234567',))
    root = hive.settings.agents_dir / legacy['id']; root.mkdir(exist_ok=True)
    (root / 'token').write_text('invented legacy credential sentinel')
    assert client.get('/api/agents/' + legacy['id']).status_code == 200
    assert client.get('/api/agents/' + mind['id']).status_code == 200
    exported = client.post('/api/agents/' + mind['id'] + '/export')
    assert exported.status_code == 200, exported.text
    destination = home.post('/api/swarms', json={'name': 'Invented destination', 'visibility': 'public'}).json()
    arrived = home.post('/api/agents/import?swarm_id=' + destination['id'], content=exported.content)
    assert arrived.status_code == 200, arrived.text
    assert arrived.json()['agent']['id'] == mind['id']
    assert hive.db.one('SELECT * FROM agents WHERE id=?', (legacy['id'],)) == legacy
    assert (root / 'token').read_text() == 'invented legacy credential sentinel'
