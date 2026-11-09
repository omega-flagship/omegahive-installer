"""code-test-prepare / code-test-run simple forms in the Code module client (modules/code/src/code_proposal.py).

Fake wire only (httpx.MockTransport): no host, Code, model or sandbox. The simple prepare takes digests and parent only
from the host test-context lookup; the simple run maps onto the operator's signed argv prefix; JSON forms are unchanged."""
import hashlib
import importlib.util
import json
import pathlib
import time

import httpx
import pytest

MODULE = pathlib.Path(__file__).resolve().parents[2] / "modules/code"
spec = importlib.util.spec_from_file_location("code_proposal_simple_forms", MODULE / "src/code_proposal.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)

MEMBER = "invented-member-token"
RQ, OP, KEY = "rq_" + "4" * 32, "prep-calc-1", "run-calc-1"
SUGG = "suggestion_" + "ab" * 16
PT = "pt_" + "c" * 24
WS, FORK = "ws_" + "d" * 32, "ws_" + "e" * 32
EXE = "/invented/venv/bin/python"
PREFIXES = [[EXE, "test_calculator.py"]]
HOST_PROPOSAL = {"proposal_id": SUGG, "proposal_digest": "sha256:" + "1" * 64, "normalized_hunks_digest": "sha256:" + "2" * 64}
HOST_PARENT = {"workspace_id": WS, "generation": 3, "tree_digest": "sha256:" + "3" * 64}
TOKEN = "hc1.invented." + "f" * 64


def lookup_answer(**over):
    return {"schema": "hive.controller-code-test-lookup/1", "request_id": RQ, "lease_id": "ls_one", "receiving_goal": "g_one",
            "proposal": dict(HOST_PROPOSAL), "parent": dict(HOST_PARENT), "context_only": True,
            "execution_authority": False} | over


def claims(stage, proposal=HOST_PROPOSAL, parent=HOST_PARENT, prefixes=PREFIXES):
    now = int(time.time())
    fork = {"workspace_id": None, "preparation_digest": None} if stage == "prepare" else \
        {"workspace_id": FORK, "preparation_digest": "sha256:" + "9" * 64}
    left = {"runs_remaining": 4, "runtime_seconds_remaining": 600}
    return {"id": "cap_one", "iss": "hive", "aud": "svc_code", "actor": "a_ctl", "kind": "agent", "task_id": "g_task",
            "swarm_id": "s_team", "repository_id": "synthetic", "actions": ["proposal-test"], "paths": [],
            "argv_prefixes": prefixes, "iat": now - 1, "exp": now + 600, "max_runs": 0, "max_runtime_seconds": 600,
            "member_hash": hashlib.sha256(MEMBER.encode()).hexdigest(), "grant_id": "gr_one",
            "proposal_test": {"purpose": "proposal-test", "stage": stage, "test_id": PT, "request_id": RQ, "lease_id": "ls_one",
                              "controller_id": "a_ctl", "execution_goal": "g_one", "issuer": "user:u_invented",
                              "origin_scope": {"scope_id": "scope_1", "scope_digest": "sha256:" + "5" * 64, "generation": 3},
                              "proposal": dict(proposal), "parent": dict(parent), "fork": fork,
                              "allowance": {"until": "2026-11-08T12:00:00Z", "per_launch_max_runtime_seconds": 120,
                                            "test": left, "request": {"runs_remaining": 8, "runtime_seconds_remaining": 1800},
                                            "usd": {"metered": False, "status": "unknown", "advisory_remaining_usd": None}}}}


def prepared_answer():
    return {"test_id": PT, "launch_authority": False, "accepted_source": False,
            "ack": {"test_id": PT, "fork_workspace_id": FORK, "test_tree_digest": "sha256:" + "8" * 64,
                    "preparation_digest": "sha256:" + "9" * 64, "bound_at": "2026-11-08T11:40:00.123Z"}}


UNKNOWN_LAUNCH = {"record": None, "currency": "unknown", "execution_currency": "unknown", "tested": False, "accepted_source": False}


@pytest.fixture
def wire(monkeypatch):
    seen, routes = [], {}

    def host(request):
        seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        answer = routes[request.url.path]
        answer = answer(request) if callable(answer) else answer
        return answer if isinstance(answer, httpx.Response) else httpx.Response(200, json=answer)

    class Client(cp.DelegatedProposalClient):
        def __init__(self, hive_url, member_token):
            super().__init__(hive_url, member_token, transport=httpx.MockTransport(host))

    monkeypatch.setattr(cp, "DelegatedProposalClient", Client)
    monkeypatch.setenv("HIVE_API_URL", "http://invented.invalid")
    monkeypatch.setenv("HIVE_WS_TOKEN", MEMBER)
    return seen, routes


def paths(seen):
    return [p for _, p, _ in seen]


CAP, LOOKUP = "/api/agent/code/capability", "/api/agent/code/test-context"
PREPARE, LAUNCH = "/api/agent/code/relay/v1/proposal-tests", f"/api/agent/code/relay/v1/proposal-tests/{PT}/launches"


# ---- simple prepare ----------------------------------------------------------------------------------------------

def test_simple_prepare_fills_digests_and_parent_from_the_host_context(wire):
    seen, routes = wire
    routes.update({LOOKUP: lookup_answer(), CAP: {"token": TOKEN, "claims": claims("prepare")}, PREPARE: prepared_answer()})
    out = json.loads(cp.proposal_test_prepare(RQ, OP, SUGG))
    assert out["status"] == "CONTROLLER_TEST_PREPARED" and out["test_id"] == PT and out["filled_from"] == "host_test_context"
    assert paths(seen) == [LOOKUP, CAP, PREPARE]
    assert seen[0][2] == {"request_id": RQ, "proposal_id": SUGG}                 # only the two ids go out
    assert seen[1][2] == {"service": "omegacode", "proposal_test": {
        "operation_id": OP, "request_id": RQ, "proposal": HOST_PROPOSAL,
        "parent": {"generation": HOST_PARENT["generation"], "tree_digest": HOST_PARENT["tree_digest"]}}}


def test_simple_prepare_accepts_a_quoted_proposal_id(wire):
    seen, routes = wire
    routes.update({LOOKUP: lookup_answer(), CAP: {"token": TOKEN, "claims": claims("prepare")}, PREPARE: prepared_answer()})
    assert json.loads(cp.proposal_test_prepare(f'"{RQ}"', f'"{OP}"', f'"{SUGG}"'))["status"] == "CONTROLLER_TEST_PREPARED"


@pytest.mark.parametrize("answer,code", [
    (httpx.Response(404, json={"error": {"code": "not_available"}}), "not_available"),          # foreign request
    (httpx.Response(403, json={"error": {"code": "not_controller"}}), "not_controller"),        # child or demoted
    (httpx.Response(409, json={"error": {"code": "code_test_source"}}), "code_test_source"),    # wrong/foreign proposal
    (lookup_answer(proposal=HOST_PROPOSAL | {"proposal_id": "suggestion_" + "0" * 32}), "test_context_proposal"),
    (lookup_answer(request_id="rq_" + "5" * 32), "test_context_shape"),
    (lookup_answer(execution_authority=True), "test_context_shape"),
    (lookup_answer(parent={"generation": 3, "tree_digest": HOST_PARENT["tree_digest"]}), "test_context_parent"),
])
def test_simple_prepare_refusals_stop_before_any_capability_or_preparation(wire, answer, code):
    seen, routes = wire
    routes[LOOKUP] = answer
    out = json.loads(cp.proposal_test_prepare(RQ, OP, SUGG))
    assert out["status"] == "CONTROLLER_TEST_REFUSED" and out["code"] == code and out["outcome_unknown"] is False
    assert paths(seen) == [LOOKUP]


def test_simple_prepare_never_takes_model_digests(wire):
    seen, routes = wire
    routes[LOOKUP] = lookup_answer()
    # anything that is not a bare proposal id or a full JSON preparation is refused before the wire
    out = json.loads(cp.proposal_test_prepare(RQ, OP, SUGG + " sha256:" + "0" * 64))
    assert out["status"] == "CONTROLLER_TEST_REFUSED" and seen == []
    out = json.loads(cp.proposal_test_prepare(RQ, OP, json.dumps({"proposal_id": SUGG})))
    assert out["status"] == "CONTROLLER_TEST_REFUSED" and out["code"] == "test_original_preparation" and seen == []


def test_json_prepare_is_unchanged_and_never_looks_up(wire):
    seen, routes = wire
    given = {"proposal": HOST_PROPOSAL, "parent": {"generation": 3, "tree_digest": HOST_PARENT["tree_digest"]}}
    routes.update({CAP: {"token": TOKEN, "claims": claims("prepare")}, PREPARE: prepared_answer()})
    out = json.loads(cp.proposal_test_prepare(RQ, OP, json.dumps(given)))
    assert out["status"] == "CONTROLLER_TEST_PREPARED" and "filled_from" not in out
    assert paths(seen) == [CAP, PREPARE]
    assert seen[0][2]["proposal_test"] == {"operation_id": OP, "request_id": RQ, **given}


# ---- simple run --------------------------------------------------------------------------------------------------

def launch_body(argv):
    return {"launch_key": KEY, "runtime": "python", "argv": argv, "runtime_seconds": 10}


@pytest.mark.parametrize("words", ["", "python test_calculator.py", "python3 test_calculator.py", f"{EXE} test_calculator.py"])
def test_simple_run_maps_to_the_exact_configured_command(wire, words):
    seen, routes = wire
    routes.update({CAP: {"token": TOKEN, "claims": claims("run")}, LAUNCH: httpx.Response(202, json=UNKNOWN_LAUNCH)})
    out = json.loads(cp.proposal_test_run(PT, KEY, words))
    assert paths(seen) == [CAP, LAUNCH]                                      # one run claim, one launch
    assert seen[0][2] == {"service": "omegacode", "proposal_test": {"test_id": PT, "stage": "run"}}
    assert seen[1][2] == launch_body([EXE, "test_calculator.py"])
    assert out["command"] == {"runtime": "python", "argv": [EXE, "test_calculator.py"], "runtime_seconds": 10}
    assert out["status"] == "CONTROLLER_TEST_UNKNOWN" and out["recovery"]["launch_key"] == KEY


def test_simple_run_two_argument_call_is_the_default_command(wire):
    seen, routes = wire
    routes.update({CAP: {"token": TOKEN, "claims": claims("run")}, LAUNCH: httpx.Response(202, json=UNKNOWN_LAUNCH)})
    cp.proposal_test_run(PT, KEY)
    assert seen[1][2] == launch_body([EXE, "test_calculator.py"])
    skills = (MODULE / "skills.metta").read_text(encoding="utf-8")
    assert '(= (code-test-run $test $launch) (py-call (code_proposal.proposal_test_run $test $launch "")))' in skills


@pytest.mark.parametrize("prefixes,words,code", [
    (PREFIXES, "python other_test.py", "test_command_outside_operator_prefix"),
    (PREFIXES, "node test_calculator.py", "test_simple_command_is_python_file"),
    (PREFIXES, "python", "test_simple_command_is_python_file"),
    ([[EXE, "a.py"], [EXE, "b.py"]], "", "test_default_command_unknown"),   # two prefixes: no single default
    ([[EXE]], "", "test_default_command_unknown"),                          # bare exe is not a test command
    ([["python", "x.py"]], "python x.py", "test_python_exe_not_configured"),  # never a relative or guessed exe
    ([[EXE, "x.py"], ["/other/python3", "x.py"]], "python x.py", "test_python_exe_not_configured"),
])
def test_simple_run_refuses_without_launching_when_the_command_is_not_the_configured_one(wire, prefixes, words, code):
    seen, routes = wire
    routes.update({CAP: {"token": TOKEN, "claims": claims("run", prefixes=prefixes)}, LAUNCH: UNKNOWN_LAUNCH})
    out = json.loads(cp.proposal_test_run(PT, KEY, words))
    assert out["status"] == "CONTROLLER_TEST_REFUSED" and out["code"] == code and out["outcome_unknown"] is False
    assert paths(seen) == [CAP]


def test_json_run_is_unchanged(wire):
    seen, routes = wire
    routes.update({CAP: {"token": TOKEN, "claims": claims("run")}, LAUNCH: httpx.Response(202, json=UNKNOWN_LAUNCH)})
    command = {"runtime": "python", "argv": [EXE, "test_calculator.py"], "runtime_seconds": 30}
    out = json.loads(cp.proposal_test_run(PT, KEY, json.dumps(command)))
    assert paths(seen) == [CAP, LAUNCH] and seen[1][2] == {"launch_key": KEY, **command} and "command" not in out
    seen.clear()
    out = json.loads(cp.proposal_test_run(PT, KEY, json.dumps({"runtime": "python", "argv": [EXE], "runtime_seconds": 200})))
    assert out["code"] == "test_integer" and seen == []                      # JSON validation still before the wire


# ---- cards and help ------------------------------------------------------------------------------------------------

def test_cards_and_help_show_the_simple_forms_first_with_one_example_each():
    card = (MODULE / "affordance.metta").read_text(encoding="utf-8")
    help_text = (MODULE / "catalog.metta").read_text(encoding="utf-8")
    for head, simple, example in (
            ("code-test-prepare", "code-test-prepare rq_id stable_operation proposal_id",
             "code-test-prepare rq_abc prep-calc-1 suggestion_0123456789abcdef0123456789abcdef"),
            ("code-test-run", "code-test-run pt_id launch_key", "code-test-run pt_0123456789abcdef01234567 run-calc-1")):
        for source, kind in ((card, "SkillCardLine"), (help_text, "SkillHelp")):
            line = next(l for l in source.splitlines() if l.startswith(f'({kind} "{head}"'))
            text = line.split('" "', 1)[1]
            assert text.startswith(simple) and example in text and text.index(simple) < text.index("JSON")
    example = "suggestion_0123456789abcdef0123456789abcdef"
    assert cp.SIMPLE_PROPOSAL.fullmatch(example)


@pytest.mark.parametrize("wrong", [RQ, "g_" + "7" * 32, "calculator.py"])
@pytest.mark.parametrize("call", ["context", "read", "propose"])
def test_proposal_heads_refuse_a_non_workspace_id_in_one_plain_line_before_any_wire(monkeypatch, wrong, call):
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:9")   # never reached: refused before any request
    monkeypatch.setenv("HIVE_WS_TOKEN", MEMBER)
    out = {"context": lambda: cp.proposal_context(wrong),
           "read": lambda: cp.proposal_read(wrong, "calculator.py"),
           "propose": lambda: cp.propose(wrong, "op_invented_1", json.dumps([{"path": "calculator.py", "start_byte": 28,
                     "end_byte": 29, "replacement": "+", "before_digest": "0" * 64}]))}[call]()
    body = json.loads(out)
    assert body["status"] == "PROPOSAL_REFUSED" and body["code"] == "workspace_id_required"
    assert body["outcome_unknown"] is False
    message = body["message"]
    assert "workspace id ws_" in message and "request id rq_" in message
    assert "\n" not in message and not set(message) & set(';()"[]{}')   # one MeTTa-safe line
    assert ";" not in out


def test_a_workspace_id_is_not_refused_as_the_wrong_kind(monkeypatch):
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HIVE_WS_TOKEN", MEMBER)
    body = json.loads(cp.proposal_context(WS))
    assert body["code"] != "workspace_id_required" and "message" not in body


def test_propose_accepts_a_wrapped_hunk_list_as_the_same_list(monkeypatch):
    """Live attempt 15: terra sent {"hunks": [...]} and was refused 'hunks' twice."""
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HIVE_WS_TOKEN", MEMBER)
    seen = {}
    monkeypatch.setattr(cp.DelegatedProposalClient, "propose",
                        lambda self, ws, op, hunks: seen.setdefault("hunks", hunks) and {"status": "PROPOSAL_RETAINED"})
    monkeypatch.setattr(cp.DelegatedProposalClient, "close", lambda self: None, raising=False)
    hunk = {"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+", "before_digest": "0" * 64}
    cp.propose(WS, "op_invented_2", json.dumps({"hunks": [hunk]}))
    assert seen["hunks"] == [hunk]
    seen.clear()
    cp.propose(WS, "op_invented_3", json.dumps([hunk]))
    assert seen["hunks"] == [hunk]


def test_hunk_refusal_lines_are_plain_and_metta_safe():
    for code in ("hunks", "hunk_source_or_scope"):
        message = cp.PLAIN_REFUSALS[code]
        assert "\n" not in message and not set(message) & set(';()"[]{}'), code
    assert "JSON list" in cp.PLAIN_REFUSALS["hunks"] and "person_ranges" in cp.PLAIN_REFUSALS["hunk_source_or_scope"]


def _fill_client(monkeypatch, content=b"def add(a, b):\n    return a - b\n"):
    client = cp.DelegatedProposalClient.__new__(cp.DelegatedProposalClient)
    scope = {"id": "scope_x", "binding": {}, "ranges": {"calculator.py": [[28, 29]]}}
    monkeypatch.setattr(client, "_scope", lambda ws: ("tok", {}, scope), raising=False)
    monkeypatch.setattr(client, "_read", lambda tok, sc, p: {"content": content.decode()}, raising=False)
    seen = {}

    class Stop(Exception):
        pass

    def fake_prepare(binding, files, ranges, hunks, *a, **k):
        seen["hunks"] = hunks
        raise Stop()
    monkeypatch.setattr(cp, "prepare", fake_prepare)
    return client, seen, Stop, content


def test_propose_fills_before_digest_only_for_an_exact_person_range(monkeypatch):
    """Live attempt 17: the helper lost before_digest from its history and gave up."""
    client, seen, Stop, content = _fill_client(monkeypatch)
    with pytest.raises(Stop):
        client.propose(WS, "op_invented_4", [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+"}])
    assert seen["hunks"][0]["before_digest"] == hashlib.sha256(content[28:29]).hexdigest()
    # not an exact person range: left as given, so prepare refuses it for its missing field
    with pytest.raises(Stop):
        client.propose(WS, "op_invented_5", [{"path": "calculator.py", "start_byte": 27, "end_byte": 29, "replacement": "+"}])
    assert "before_digest" not in seen["hunks"][0]
    # a given before_digest is never replaced
    with pytest.raises(Stop):
        client.propose(WS, "op_invented_6", [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+",
                                              "before_digest": "0" * 64}])
    assert seen["hunks"][0]["before_digest"] == "0" * 64



def test_the_default_picks_the_one_plain_python_file_among_several_prefixes():
    """Live Code test 19: a python file command beside a unittest-discover one had no default."""
    prefixes = [[EXE, "test_calculator.py"], [EXE, "-B", "-m", "unittest", "discover", "-s", "checks", "-p", "test_demo_note.py"]]
    assert cp.simple_run_command(prefixes, [])["argv"] == [EXE, "test_calculator.py"]
    message = cp.PLAIN_REFUSALS["test_default_command_unknown"]
    assert "\n" not in message and not set(message) & set(';()"[]{}')
