"""Purpose: an unlisted command asks; the pinned existing gate heads keep their reviewed default decisions, 6606's
except the closed list of omega-flagship/omegahive#232, which asks (#230 step 5), and the heads that build software,
which a mind is refused until its owner switches its own coding on (omega-flagship/omegahive#395, own_code)."""
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


def test_existing_6606_command_heads_keep_their_reviewed_defaults(client, monkeypatch):
    hive, agent = mind(client)
    # Compare ordinary defaults after the existing consent prerequisite. The connector policy suite separately
    # verifies that no default or explicit allow can bypass missing consent or the app's permission ceiling.
    monkeypatch.setattr(hive.google_connector, 'mind_allowed', lambda _agent: True)
    pinned = json.loads((Path(__file__).parent / 'fixtures/policy_defaults_6606.json').read_text())
    assert len(pinned['defaults']) == 425
    for skill, expected in pinned['defaults'].items():
        assert command_skill(f'({skill})') == skill, skill
        assert hive.policy.decide(agent, skill)[0] == expected, skill


def test_each_head_that_builds_software_is_explained_and_comes_back_with_its_owner_s_switch(client, monkeypatch):
    """The fixture's own_code block explains every pinned default Jon's line on omega-flagship/omegahive#395 changed:
    the wall refuses exactly the heads it lists, and once the mind's owner switches its own coding on each has the
    default it had before."""
    hive, agent = mind(client)
    monkeypatch.setattr(hive.google_connector, 'mind_allowed', lambda _agent: True)
    pinned = json.loads((Path(__file__).parent / 'fixtures/policy_defaults_6606.json').read_text())
    was = pinned['own_code']['was']
    assert {skill for skill in pinned['defaults'] if hive.policy.own_code(agent, skill)} == set(was)
    assert {pinned['defaults'][skill] for skill in was} == {'deny'}
    hive.db.execute('UPDATE agents SET owner = ? WHERE id = ?', ('user:u_owner', agent['id']))
    hive.update_agent(agent['id'], {'options': {'own_coding': True}}, by='user:u_owner')
    coding = hive.agent(agent['id'])
    assert {skill: hive.policy.decide(coding, skill)[0] for skill in was} == was


@pytest.mark.parametrize('skill', ['repo-query', 'generate-image', 'code-test-run', 'persistent-note'])
def test_existing_heads_still_obey_explicit_restrictions(client, skill):
    hive, agent = mind(client)
    hive.policy.add_rule(f"agent:{agent['id']}", skill, 'deny', 'invented explicit boundary')
    assert hive.policy.decide(agent, skill)[0] == 'deny'


def test_an_exact_review_rule_can_authorize_an_otherwise_unknown_skill(client):
    hive, agent = mind(client)
    hive.policy.add_rule(f"agent:{agent['id']}", 'invented-reviewed-command', 'allow', 'reviewed for this mind')
    assert hive.policy.authorize(agent, '(invented-reviewed-command "x")')['decision'] == 'allow'
