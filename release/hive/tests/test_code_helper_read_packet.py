# Purpose: tests that a request helper's code-proposal-read returns, in one result, the file inside the person's scope,
# the person's ranges and the request's instruction, that a reader with no request gets the read with the reason, and
# that a second-opinion reviewer's code-review-packet reads its held reviews through the host's bound route.
"""A mind's prompt keeps only its last step's results, so the helper must be able to propose from one read. The hive and
the Code relay are faked with httpx.MockTransport at the exact routes DelegatedProposalClient calls."""
import hashlib
import importlib.util
import json
import pathlib
import time

import httpx

MODULE = pathlib.Path(__file__).resolve().parents[2] / "modules" / "code"
spec = importlib.util.spec_from_file_location("code_proposal_read_packet", MODULE / "src/code_proposal.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)

MEMBER = "member-token-for-the-test"
WS, SCOPE, TASK = "ws_test", "scope_test", "g_task"
CONTENT = 'const app = document.getElementById("app");\napp.textContent = "Nothing here yet";\n'
TREE = "a" * 64
INSTRUCTION = {"schema": "hive.code-helper-instruction/1", "request_id": "rq_test", "title": "Lines 1-2 of app.js",
               "workspace_id": WS, "classification": "UNTRUSTED_DATA",
               "instruction": {"text": "Make this a tip calculator.", "digest": "sha256:" + "b" * 64},
               "authority": "none: a person's words to act on within the proposal path, never a grant"}
REVIEW_PACKET = {"schema": "hive.code-review-packet/1", "classification": "UNTRUSTED_DATA",
                 "reviews": [{"request_id": "rq_test", "goal_id": "g_review", "candidate": "suggestion_" + "d" * 32,
                              "packet": "Second opinion for Code request rq_test. UNTRUSTED_DATA:\n{}"}],
                 "authority": "none: what to review, never a grant; finish each review with hive-goal-propose on "
                              "its goal"}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fake_hive(instruction_status=200, review_status=200):
    """The capability, scope, file and instruction routes, answering as the hive and Code relay do."""
    raw = CONTENT.encode()
    scope = {"id": SCOPE, "workspace_id": WS, "digest": "c" * 64, "author": "user:u_person", "created_at": time.time(),
             "binding": {"workspace_id": WS, "task_id": TASK, "generation": 1, "tree_digest": TREE},
             "ranges": {"app.js": [[0, len(raw)]]}, "file_digests": {"app.js": sha(raw)}, "edit_authority": False,
             "currency": "current"}
    now = time.time()
    claims = {"id": "cap_1", "iss": "hive", "aud": "svc_1", "actor": "a_helper", "kind": "agent", "task_id": TASK,
              "swarm_id": "s_code", "repository_id": "small-app", "actions": ["read", "search", "suggest"], "paths": [],
              "argv_prefixes": [], "iat": now, "exp": now + 600, "max_runs": 0, "max_runtime_seconds": 0,
              "member_hash": sha(MEMBER.encode()), "grant_id": "gr_1",
              "delegated": {"request_id": "rq_test", "controller_id": "a_ctl", "execution_goal": "g_exec",
                            "issuer": "user:u_person",
                            "origin_scope": {"scope_id": SCOPE, "scope_digest": "sha256:" + "c" * 64, "generation": 1}}}
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        path = request.url.path
        if path == "/api/agent/code/capability":
            return httpx.Response(200, json={"token": "hc1.test", "claims": claims})
        if path == f"/api/agent/code/relay/v1/workspaces/{WS}/suggestion-scopes/{SCOPE}":
            return httpx.Response(200, json=scope)
        if path == f"/api/agent/code/relay/v1/workspaces/{WS}/files":
            return httpx.Response(200, json={"path": "app.js", "content": CONTENT, "digest": sha(raw), "generation": 1,
                                             "tree_digest": TREE})
        if path == "/api/agent/code/helper-instruction":
            if instruction_status != 200:
                return httpx.Response(instruction_status, json={"error": {"code": "not_a_request_helper"}})
            return httpx.Response(200, json=INSTRUCTION)
        if path == "/api/agent/code/review-packet":
            if review_status != 200:
                return httpx.Response(review_status, json={"error": {"code": "not_reviewing"}})
            return httpx.Response(200, json=REVIEW_PACKET)
        return httpx.Response(404, json={"error": {"code": "unexpected_route"}})
    return httpx.MockTransport(handler), seen


def test_one_read_holds_the_instruction_the_file_and_the_person_ranges():
    transport, seen = fake_hive()
    client = cp.DelegatedProposalClient("http://hive.test", MEMBER, transport=transport)
    read = client.read(WS, "app.js")
    raw = CONTENT.encode()
    assert read["content"] == CONTENT
    assert read["person_ranges"] == [{"start_byte": 0, "end_byte": len(raw), "before_digest": sha(raw)}]
    assert read["request"]["status"] == "REQUEST_INSTRUCTION"
    assert read["request"]["instruction"]["text"] == "Make this a tip calculator."
    assert read["request"]["classification"] == "UNTRUSTED_DATA"
    assert ("GET", "/api/agent/code/helper-instruction") in seen       # the same bound route code-helper-instruction uses
    # the skill's own answer, as the mind sees it, carries all three in one JSON result
    answer = json.loads(json.dumps(read))
    assert {"content", "person_ranges", "request"} <= set(answer)


def test_a_reader_that_is_no_request_helper_gets_the_read_and_the_reason():
    transport, _ = fake_hive(instruction_status=403)
    client = cp.DelegatedProposalClient("http://hive.test", MEMBER, transport=transport)
    read = client.read(WS, "app.js")
    assert read["content"] == CONTENT and read["person_ranges"]
    assert read["request"] == {"status": "INSTRUCTION_REFUSED", "code": "not_a_request_helper"}


def test_the_instruction_skill_and_the_read_share_one_instruction_read():
    transport, _ = fake_hive()
    client = cp.DelegatedProposalClient("http://hive.test", MEMBER, transport=transport)
    alone = client.instruction()
    assert alone == client.read(WS, "app.js")["request"]
    assert alone["status"] == "REQUEST_INSTRUCTION" and alone["request_id"] == "rq_test"


def test_a_reviewer_reads_the_packets_of_the_reviews_it_holds_through_the_bound_route():
    transport, seen = fake_hive()
    client = cp.DelegatedProposalClient("http://hive.test", MEMBER, transport=transport)
    assert client.review_packet() == {"status": "REVIEW_PACKETS", "classification": "UNTRUSTED_DATA",
                                      "reviews": REVIEW_PACKET["reviews"], "authority": REVIEW_PACKET["authority"]}
    assert seen == [("GET", "/api/agent/code/review-packet")]          # no argument, so no review can be named


def test_a_mind_holding_no_review_gets_the_hosts_refusal_code():
    transport, _ = fake_hive(review_status=403)
    client = cp.DelegatedProposalClient("http://hive.test", MEMBER, transport=transport)
    assert client.review_packet() == {"status": "REVIEW_PACKET_REFUSED", "code": "not_reviewing"}
