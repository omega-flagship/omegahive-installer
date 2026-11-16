"""Purpose: verify that the reviewed packet reader preserves consent rules and unknown-skill boundaries."""

import pytest

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401


@pytest.mark.parametrize("pattern", ["code-review-packet", "code-*"])
@pytest.mark.parametrize("mode", ["ask", "deny"])
def test_packet_default_preserves_person_restrictions(client, pattern, mode):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    hive = client.app.state.hive
    hive.policy.add_rule(f"agent:{mind['id']}", pattern, mode, "person restriction")
    response = client.post("/api/agent/authorize", headers=agent_headers(mind),
                           json={"command": "(code-review-packet)"})
    assert response.status_code == 200, response.text
    assert response.json()["decision"] == {"ask": "pending", "deny": "deny"}[mode]


def test_packet_default_does_not_review_other_code_skills(client):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    response = client.post("/api/agent/authorize", headers=agent_headers(mind),
                           json={"command": "(code-review-packet-unreviewed)"})
    assert response.status_code == 200, response.text
    assert response.json()["decision"] == "pending"
