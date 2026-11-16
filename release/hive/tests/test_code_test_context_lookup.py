"""POST /api/agent/code/test-context: the request controller's own host lookup of one retained proposal's test references
(code_test_intents.controller_lookup), so code-test-prepare's simple form never takes digests from a model.
Synthetic only: a fake Code proxy answer, no Code process, no provider calls, no spawn of a real mind."""
import json

from hive.core.minds import canonical, sha
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import enabled, spawn, w  # noqa: F401  (fixture)
from hive.tests.test_proposal_tests import SCOPE_DIGEST, SUGGESTION, WS, pw  # noqa: F401  (fixture)

ROUTE = "/api/agent/code/test-context"
RECORD_DIGEST, CONTENT_DIGEST, TREE_HEX = "e1" * 32, "f2" * 32, "a3" * 32


def readback(pw, author, proposal_id=SUGGESTION, decisions=()):
    req = pw.hive.minds._request(pw.rq["request_id"])
    record = {"id": proposal_id, "workspace_id": WS, "digest": RECORD_DIGEST, "author": author}
    content = {"digest": CONTENT_DIGEST, "binding": {"workspace_id": WS, "task_id": pw.task["id"], "generation": 1,
                                                     "tree_digest": TREE_HEX}}
    provenance = {"schema": "omegacode-request-proposal-v1", "workspace_id": WS, "proposal_id": proposal_id,
                  "proposal_digest": RECORD_DIGEST, "author": author, "origin_task_id": pw.task["id"],
                  "origin_swarm_id": pw.origin["id"], "repository_id": "synthetic",
                  "delegated": {"request_id": req["id"], "controller_id": pw.ctl["id"], "execution_goal": req["receiving_goal"],
                                "issuer": "user:u_jon", "origin_scope": {"scope_id": "scope_1", "scope_digest": SCOPE_DIGEST,
                                                                         "generation": 1}}}
    return json.dumps({"record": record, "content": content, "decisions": list(decisions), "currency": "current",
                       "request_binding": {"content": provenance, "digest": sha(canonical(provenance)).removeprefix("sha256:")}}).encode()   # OmegaCode sends bare hex


def fake_code(pw, monkeypatch, answer):
    calls = []

    async def proxy(principal, method, path, query, body, task_id, grant_id, repository_id):
        calls.append((principal, method, path, query, task_id, grant_id, repository_id))
        return answer() if callable(answer) else answer

    monkeypatch.setattr(pw.hive.code, "proxy", proxy)
    return calls


def lookup(pw, agent=None, **body):
    return pw.client.post(ROUTE, headers=agent_headers(agent or pw.ctl),
                          json={"request_id": pw.rq["request_id"], "proposal_id": SUGGESTION} | body)


def test_the_controller_gets_host_filled_digests_and_parent_for_its_own_childs_proposal(pw, monkeypatch):
    enabled(pw)
    child = spawn(pw, pw.rq["request_id"]).json()["child_id"]
    calls = fake_code(pw, monkeypatch, (200, readback(pw, child), "application/json"))
    out = lookup(pw)
    assert out.status_code == 200, out.text
    assert out.json() == {"schema": "hive.controller-code-test-lookup/1", "request_id": pw.rq["request_id"],
                          "lease_id": pw.hive.minds._request_lease(pw.rq["request_id"])["id"],
                          "receiving_goal": pw.hive.minds._request(pw.rq["request_id"])["receiving_goal"],
                          "proposal": {"proposal_id": SUGGESTION, "proposal_digest": "sha256:" + RECORD_DIGEST,
                                       "normalized_hunks_digest": "sha256:" + CONTENT_DIGEST},
                          "parent": {"workspace_id": WS, "generation": 1, "tree_digest": "sha256:" + TREE_HEX},
                          "context_only": True, "execution_authority": False}
    # read in the original person's scope under the lease's grant, never as the mind
    assert calls == [("user:u_jon", "GET", f"/v1/workspaces/{WS}/suggestions/{SUGGESTION}", {"include_request_binding": "true"},
                      pw.task["id"], pw.grant["id"], "synthetic")]


def test_a_foreign_controller_or_a_child_cannot_look_up_the_request(pw, monkeypatch):
    enabled(pw)
    child_id = spawn(pw, pw.rq["request_id"]).json()["child_id"]
    calls = fake_code(pw, monkeypatch, (200, readback(pw, pw.ctl["id"]), "application/json"))
    out = lookup(pw, agent=pw.fctl)                              # another team's controller: not visible
    assert out.status_code == 404 and out.json()["error"]["code"] == "not_available"
    child = {"token": pw.tokens[child_id]}
    out = pw.client.post(ROUTE, headers={"Authorization": f"Bearer {child['token']}"},
                         json={"request_id": pw.rq["request_id"], "proposal_id": SUGGESTION})
    assert out.status_code == 403 and out.json()["error"]["code"] == "not_controller"
    out = lookup(pw, request_id="rq_" + "0" * 32)                  # no such request
    assert out.status_code == 404
    assert calls == []                                             # refused before any Source read


def test_a_wrong_or_foreign_proposal_is_refused(pw, monkeypatch):
    # authored by a mind that is neither this controller nor its child for this request
    fake_code(pw, monkeypatch, (200, readback(pw, pw.helper["id"]), "application/json"))
    out = lookup(pw)
    assert out.status_code == 409 and out.json()["error"]["code"] == "code_test_source"
    # Code answers with a different proposal than the one asked for
    fake_code(pw, monkeypatch, (200, readback(pw, pw.ctl["id"], proposal_id="suggestion_" + "1" * 32), "application/json"))
    assert lookup(pw).json()["error"]["code"] == "code_test_source"
    # an already decided proposal is not testable
    fake_code(pw, monkeypatch, (200, readback(pw, pw.ctl["id"], decisions=[{"decision": "accept"}]), "application/json"))
    assert lookup(pw).json()["error"]["code"] == "code_test_source"
    # Code cannot find it in the person scope
    fake_code(pw, monkeypatch, (404, b"{}", "application/json"))
    assert lookup(pw).json()["error"]["code"] == "code_test_source"


def test_the_lookup_keeps_request_and_lease_checks_and_its_exact_body(pw, monkeypatch):
    calls = fake_code(pw, monkeypatch, (200, readback(pw, pw.ctl["id"]), "application/json"))
    out = lookup(pw, proposal_digest="sha256:" + "0" * 64)          # a caller digest is never accepted
    assert out.status_code == 400
    assert lookup(pw, proposal_id="suggestion_XYZ").status_code == 400
    pw.hive.services.revoke_grant(pw.task["id"], pw.grant["id"])    # the person's grant ends
    assert lookup(pw).status_code in (403, 409)
    assert calls == []
    pw.hive.settings.proposal_test_claims = False
    out = lookup(pw)
    assert out.status_code == 503 and out.json()["error"]["code"] == "proposal_tests_off"


def test_request_binding_digest_bare_or_prefixed_matches_and_nothing_else():
    """Live Code test 18: OmegaCode's bare-hex request_binding digest never matched the hive's prefixed sha()."""
    from hive.core.code_test_intents import _bare
    hexd = "a" * 64
    assert _bare(hexd) == hexd and _bare("sha256:" + hexd) == hexd
    for bad in ("", "sha256:", "A" * 64, "a" * 63, None, 7, "sha512:" + hexd):
        assert _bare(bad) is None, bad
