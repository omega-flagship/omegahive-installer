"""Purpose: keep caller statements as data across commons publishing, reading and replay."""

import importlib.util
import json
import os
from pathlib import Path
import re
import secrets

import pytest

from hive.spaces import sexpr
from hive.spaces.service import SpaceService
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401
from hive.tests.test_visibility import person

ROOT = Path(__file__).resolve().parents[2]
PETTA = os.environ.get("PETTA_PATH", str(Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


@pytest.fixture
def canary(client):
    """A trusted extension sharing a logical head writes only a disposable marker if evaluated."""
    spaces = client.app.state.hive.spaces
    marker = "&data_boundary_" + secrets.token_hex(8)
    definitions = []

    def register(head):
        definition = (f"(= ({head} $a $b) (let $seen (add-atom {marker} (Ran)) "
                      f"(quote ({head} $a $b))))")
        spaces.run(f"!(add-atom &self {definition})")
        definitions.append(definition)

    def calls():
        return spaces.run_one(f"!(collapse (match {marker} $x $x))")

    try:
        yield register, calls
    finally:
        for definition in reversed(definitions):
            spaces.run(f"!(remove-atom &self {definition})")


@pytest.mark.parametrize("head", sorted(sexpr.STATEMENT_HEADS - {"&&"}))
@pytest.mark.parametrize("granted", [False, True])
def test_registered_connectives_are_data_before_the_grant_check(client, canary, head, granted):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    spaces = client.app.state.hive.spaces
    register, calls = canary
    if not granted:
        spaces.revoke(agent["id"], swarm["id"])
    register(head)
    statement = f"({head} left right)"
    assert sexpr.safe_commons_statement(statement) == statement
    result = spaces.publish(swarm["id"], agent["id"], statement, .9, .8, [f"ev:{agent['id']}:1"])
    assert result["outcome"] == ("adopted" if granted else "denied")
    assert calls() == []


def test_every_registered_or_special_form_is_rejected_as_a_publish_head(client, monkeypatch):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    spaces = client.app.state.hive.spaces
    names = set(spaces.run_one("!(collapse (let True (callPredicate (Predicate (fun $f))) $f))"))
    translator = Path(PETTA, "src", "translator.pl").read_text()
    names.update(a or b for a, b in re.findall(r"\bHV == (?:'([^']+)'|([A-Za-z0-9_|><=!*+\-]+))", translator))
    assert {"py-call", "quote", "eval", "|->", "add-atom", "match"} <= names

    def unexpected_evaluation(*args, **kwargs):
        pytest.fail("a rejected statement reached the interpreter")

    monkeypatch.setattr(spaces, "run_one", unexpected_evaluation)
    for head in names - sexpr.STATEMENT_HEADS:
        for statement in (f"({head} a b)", f"(--> sky ({head} a b))"):
            with pytest.raises(sexpr.SexprError):
                spaces.publish(swarm["id"], agent["id"], statement, .9, .8, [f"ev:{agent['id']}:1"])


def test_a_member_created_mind_cannot_execute_python_through_query(client, tmp_path):
    member = person(client, "u_query_boundary")
    swarm = client.post("/api/swarms", headers=member, json={"name": "Query boundary"}).json()
    agent = client.post("/api/agents", headers=member,
                        json={"name": "Query reader", "swarm_id": swarm["id"]}).json()
    marker = tmp_path / "query.canary"
    expression = f'(py-call (.write_text (py-call (pathlib.Path {json.dumps(str(marker))})) "canary"))'
    pattern = f"(Current (--> marker {expression}) $tv $stamp)"
    # A person token is refused; the member's own mind token still performs the literal query.
    assert client.post("/api/agent/query", headers=member, json={"pattern": pattern}).status_code == 401
    result = client.post("/api/agent/query", headers=agent_headers(agent), json={"pattern": pattern})
    assert result.status_code == 200, result.text
    assert result.json() == {"results": []}
    assert not marker.exists()


@pytest.mark.parametrize("route", ["http", "mcp", "iter", "native"])
def test_each_publish_adapter_keeps_nested_statement_data(client, canary, monkeypatch, route):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    headers = agent_headers(agent)
    if route == "mcp":
        invite = client.post("/api/harness-invites", json={"harness": "mcp", "name": "Data boundary",
                             "swarm_id": swarm["id"]}).json()
        headers = {"Authorization": "Bearer " + invite["code"]}
    register, calls = canary
    register("x")
    statement = "(--> (x cat dog) friends)"
    payload = {"statement": statement, "f": .9, "c": .8}
    if route == "mcp":
        response = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1,
                               "method": "tools/call", "params": {"name": "hive_publish", "arguments": payload}})
        response.raise_for_status()
        result = response.json()["result"]["structuredContent"]
        assert result["outcome"] == "adopted"
    elif route == "http":
        response = client.post("/api/agent/publish", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        assert response.json()["outcome"] == "adopted"
    else:
        relative = "hive/templates/iter/tools/hive_publish.py" if route == "iter" else "modules/hive/src/hive_commons.py"
        spec = importlib.util.spec_from_file_location("commons_boundary_adapter", ROOT / relative)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def transport(method, path, data):
            response = client.request(method, path, headers=headers, json=data)
            assert response.status_code == 200, response.text
            return response.json(), None

        monkeypatch.setattr(module._hive if route == "iter" else module,
                            "call" if route == "iter" else "_call", transport)
        answer = module.run(statement, .9, .8) if route == "iter" else module.publish(statement, .9, .8)
        assert "adopted" in answer
    assert calls() == []
    assert client.app.state.hive.spaces.beliefs(swarm["id"])[0]["statement"] == statement


def test_revision_choice_read_and_replay_keep_statement_data(client, canary, tmp_path):
    swarm, (a, b) = make_swarm_and_agents(client)
    spaces = client.app.state.hive.spaces
    register, calls = canary
    register("x")
    statement = "(--> (x cat dog) friends)"
    sa, sb = [f"ev:{a['id']}:1"], [f"ev:{b['id']}:1"]
    assert spaces.publish(swarm["id"], a["id"], statement, .9, .8, sa)["outcome"] == "adopted"
    assert spaces.publish(swarm["id"], a["id"], statement, .9, .8, sa)["outcome"] == "duplicate"
    assert spaces.publish(swarm["id"], b["id"], statement, .8, .7, sb)["outcome"] == "revised"
    assert spaces.publish(swarm["id"], a["id"], statement, .7, .5, sa)["outcome"] == "kept"
    assert spaces.publish(swarm["id"], a["id"], statement, 1., .99, sa)["outcome"] == "chosen"
    assert spaces.belief(swarm["id"], statement)["sources"]
    assert spaces.query(swarm["id"], f"(Current {statement} $tv $stamp)")
    assert calls() == []

    # Replay a granted and a denied legacy publish record through the same apply path.
    folder = tmp_path / "replay"
    folder.mkdir()
    records = [{"op": "grant", "agent_id": a["id"], "swarm_id": "replay_" + swarm["id"]},
               {"op": "publish", "agent_id": b["id"], "swarm_id": "replay_" + swarm["id"],
                "statement": statement, "f": .9, "c": .8, "stamp": sb},
               {"op": "publish", "agent_id": a["id"], "swarm_id": "replay_" + swarm["id"],
                "statement": statement, "f": .9, "c": .8, "stamp": sa}]
    (folder / "spaces.log.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records))
    replayed = SpaceService(folder)
    assert replayed.beliefs("replay_" + swarm["id"]) == []  # granted, but vocabulary is closed during replay
    assert calls() == []


def test_snapshot_replay_and_governance_keep_statement_data(client, canary, tmp_path):
    hive = client.app.state.hive
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    spaces = hive.spaces
    register, calls = canary
    register("x")
    statement = "(--> (x cat dog) friends)"
    assert spaces.publish(swarm["id"], agent["id"], statement, .9, .8,
                          [f"ev:{agent['id']}:1"])["outcome"] == "adopted"
    records = spaces._snapshot()
    folder = tmp_path / "snapshot"
    folder.mkdir()
    (folder / "spaces.log.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records))
    # Snapshot restoration uses add-atom's data position, which must stay unevaluated too.
    restored = SpaceService(folder)
    assert any(b["statement"] == statement for b in restored.beliefs(swarm["id"]))
    from hive.core.governance_evidence import GovernanceEvidence
    evidence = GovernanceEvidence(hive)
    assert evidence.record("data-boundary-" + secrets.token_hex(8), statement, True)["outcome"] == "adopted"
    assert calls() == []


@pytest.mark.parametrize("expression", ["(+ 1 2)", "(py-call (os.getpid))", "(eval (quote (+ 1 2)))",
                                      "(let x 1 x)", "(quote (x cat dog))", "(|-> (a) a)",
                                      "(add-atom elsewhere (thing))", "(call (current-time))"])
def test_query_patterns_are_data_even_for_executable_forms(client, expression):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    spaces = client.app.state.hive.spaces
    pattern = f"(Current (--> sky {expression}) $tv $stamp)"
    # Returned values differ after evaluation; a literal stored by add-atom makes the distinction observable.
    spaces.run(f"!(add-atom &commons_{swarm['id']} (Current (--> sky {expression}) (stv 0.9 0.8) ()))")
    answer = spaces.query(swarm["id"], pattern)
    assert len(answer) == 1
    assert sexpr.parse(answer[0]) == sexpr.parse(f"(Current (--> sky {expression}) (stv 0.9 0.8) ())")
