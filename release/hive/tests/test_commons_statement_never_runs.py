"""Purpose: verify that a statement published to a commons is data, never code (flagship review 2026-11-11, F1 and F2).

The statement used to be spliced into a hive-publish! call, so a sub-expression naming a function ran inside the hive
before the permission check: "(--> sky (py-call (os.getpid)))" was stored as the pid. Now only logical forms are
accepted (every list headed by a connective), the op log never replays one that is not, and a torn log line never stops
the hive from starting.
"""
import json
import os

import pytest

from hive.spaces import sexpr
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


@pytest.mark.parametrize("statement", [
    "(--> sky (py-call (os.getpid)))", "(py-call (os.getenv \"HOME\"))", "(--> sky (+ 1 2))",
    "(let $x 1 $x)", "(--> (foo) bar)", "(\"-->\" a b)"])
def test_a_statement_that_names_a_function_is_refused_and_never_runs(client, statement, tmp_path, monkeypatch):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    r = client.post("/api/agent/publish", headers=agent_headers(a), json={"statement": statement, "f": 0.9, "c": 0.8})
    assert r.status_code == 400, (statement, r.status_code, r.text[:200])
    beliefs = client.get(f"/api/swarms/{swarm['id']}/beliefs").json()
    assert beliefs == [] and str(os.getpid()) not in json.dumps(beliefs)   # nothing stored, nothing ran


def test_logical_forms_still_publish(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    for s in ("(--> sky blue)", "(--> (x cat dog) friends)", "(==> (--> a b) (--> b c))", "(-- (--> c d))"):
        r = client.post("/api/agent/publish", headers=agent_headers(a), json={"statement": s, "f": 0.9, "c": 0.8})
        assert r.status_code == 200 and r.json()["outcome"] in ("adopted", "quarantined"), (s, r.text[:200])


def test_the_log_never_replays_code_and_a_torn_line_does_not_stop_start(client, caplog):
    hive = client.app.state.hive
    spaces = hive.spaces
    log_path = spaces.log_path
    member = json.dumps({"op": "grant", "agent_id": "a_x", "swarm_id": "s_x"})   # a member: a publish run would be kept
    good = json.dumps({"op": "publish", "swarm_id": "s_x", "agent_id": "a_x", "statement": "(--> sky (py-call (os.getpid)))",
                       "f": 0.9, "c": 0.8, "stamp": ["ev:a_x:1"]})
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(member + "\n" + good + "\n" + '{"op": "pub')   # a code statement, then a torn last line
    spaces._replay()                                            # neither raises nor runs the call
    assert spaces.is_member("a_x", "s_x")
    assert spaces.beliefs("s_x") == [] and spaces.query("s_x", "$x") == []   # nothing was replayed into the commons
    assert "(publish) refused" in caplog.text
    assert log_path.read_bytes().endswith(b"\n")               # the torn line is gone, so the next append starts clean
    with pytest.raises(sexpr.SexprError):
        sexpr.safe_commons_statement("(--> sky (py-call (os.getpid)))")
