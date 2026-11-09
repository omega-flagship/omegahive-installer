"""An unlisted command asks; the pinned existing gate heads retain their previous default decisions."""
import json
from pathlib import Path

import pytest

from hive.core.policy import command_skill
from hive.tests.test_core_api import client  # noqa: F401


def mind(client):
    swarm = client.post('/api/swarms', json={'name': 'Invented policy swarm'}).json()
    hive = client.app.state.hive
    return hive, hive.create_agent('Invented mind', 'omega', swarm['id'], 'mock/echo', '', None, 0, None, None)


def test_unknown_skill_files_an_approval_instead_of_running(client):
    hive, agent = mind(client)
    command = '(invented-unreviewed-command "invented argument")'
    assert hive.policy.decide(agent, 'invented-unreviewed-command')[0] == 'ask'
    result = hive.policy.authorize(agent, command)
    assert result['decision'] == 'pending'
    approval = hive.policy.approval(result['approval_id'])
    assert approval['skill'] == 'invented-unreviewed-command'
    assert approval['command'] == command and approval['status'] == 'pending'


@pytest.mark.parametrize('skill', ['repo-query-new', 'code-brand-new', 'attention-brand-new', 'hive-brand-new'])
def test_existing_skill_families_do_not_implicitly_allow_new_heads(client, skill):
    hive, agent = mind(client)
    assert hive.policy.decide(agent, skill)[0] == 'ask'


def test_existing_6606_command_heads_keep_their_old_defaults(client, monkeypatch):
    hive, agent = mind(client)
    # Compare ordinary defaults after the existing consent prerequisite. The connector policy suite separately
    # verifies that no default or explicit allow can bypass missing consent or the app's permission ceiling.
    monkeypatch.setattr(hive.google_connector, 'mind_allowed', lambda _agent: True)
    pinned = json.loads((Path(__file__).parent / 'fixtures/policy_defaults_6606.json').read_text())
    assert len(pinned['defaults']) == 425
    for skill, expected in pinned['defaults'].items():
        assert command_skill(f'({skill})') == skill, skill
        assert hive.policy.decide(agent, skill)[0] == expected, skill


@pytest.mark.parametrize('skill', ['repo-query', 'generate-image', 'code-test-run', 'persistent-note'])
def test_existing_heads_still_obey_explicit_restrictions(client, skill):
    hive, agent = mind(client)
    hive.policy.add_rule(f"agent:{agent['id']}", skill, 'deny', 'invented explicit boundary')
    assert hive.policy.decide(agent, skill)[0] == 'deny'


def test_an_exact_review_rule_can_authorize_an_otherwise_unknown_skill(client):
    hive, agent = mind(client)
    hive.policy.add_rule(f"agent:{agent['id']}", 'invented-reviewed-command', 'allow', 'reviewed for this mind')
    assert hive.policy.authorize(agent, '(invented-reviewed-command "x")')['decision'] == 'allow'
