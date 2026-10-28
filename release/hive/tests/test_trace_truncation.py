import hashlib

from hive.core.hive import TRACE_TEXT_MAX
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_long_results_are_kept_far_past_2000_and_any_cut_is_marked(client):
    _, (a, _b) = make_swarm_and_agents(client)
    mid = "e1:" + "x" * 5000 + " e2:" + "y" * 100
    huge = "z" * (TRACE_TEXT_MAX + 50)
    r = client.post("/api/agent/trace", headers=agent_headers(a),
                    json={"iteration": 1, "response": "r", "commands": [{"command": "(read)", "result": mid},
                                                                         {"command": "(read2)", "result": huge}]})
    assert r.status_code == 200, r.text
    cmds = client.get(f"/api/agents/{a['id']}/traces?limit=1").json()[0]["commands"]
    assert cmds[0]["result"] == mid and "result_truncated" not in cmds[0]          # e2 survives whole
    cut = cmds[1]["result_truncated"]
    assert len(cmds[1]["result"]) == TRACE_TEXT_MAX and cut["total_chars"] == len(huge)
    assert cut["sha256"] == hashlib.sha256(huge.encode()).hexdigest()
