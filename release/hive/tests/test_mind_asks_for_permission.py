# Purpose: tests that a mind lacking an explicit-only skill files the request itself, one per skill, that a hive admin's
# answer applies it with a rule (For a time, Always) or ends it (No, Never), that Once is refused for it and only an
# admin answers one, and that every refusal someone chose stays a plain refusal with nothing filed.
"""A mind asks for a permission it lacks, and a hive admin only approves it (Jon, testers' chat, 13 Nov).

"when a permission is needed the agent should essentially create it and then just get us to approve to apply". A
tester found the Rules page and had to type a rule by hand, and said of her mind "It doesn't know how to request". On
main a refused skill answers HIVE-DENIED and files nothing. An explicit-only skill is the policy's own "an admin grants
it", so now a mind's use of one files the request. A refusal someone chose, a person's rule or Never, a role's list or
the hive's own design, stays a refusal the mind reports.

Invented lives: Rosa runs a bakery swarm whose mind Juno looks things up; Ines is a member with a mind of her own.
"""
import time

import pytest

from hive.core.hive import HiveError, token_hash
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

SPAWN = '(code-mind-spawn "{}")'   # an explicit-only skill (policy.EXPLICIT_ONLY): an admin grants it mind by mind


def _juno(client):
    hive = client.app.state.hive
    bakery = client.post("/api/swarms", json={"name": "Bakery"}).json()
    return hive, hive.create_agent("Juno", "omega", bakery["id"], "mock/echo", "", None, 0, None, None)


def _try(client, agent, command):
    return client.post("/api/agent/authorize", headers=agent_headers(agent), json={"command": command}).json()


def _grants(hive, agent):
    return hive.db.all("SELECT * FROM approvals WHERE agent_id = ? AND kind = 'grant' ORDER BY created_at", (agent["id"],))


def _answer(client, approval_id, decision, **extra):
    return client.post(f"/api/approvals/{approval_id}/decide", json={"decision": decision, **extra})


def test_an_explicit_only_skill_files_one_request_and_an_admins_always_writes_its_exact_rule(client):
    hive, juno = _juno(client)
    first = _try(client, juno, SPAWN)
    assert first["decision"] == "pending" and first["message"].startswith(f"HIVE-PERMISSION-REQUESTED {first['approval_id']}: ")
    assert "needs an exact allow rule" in first["message"] and "asked a hive admin" in first["message"]
    [request] = _grants(hive, juno)
    assert request["id"] == first["approval_id"] and request["skill"] == "code-mind-spawn" and request["status"] == "pending"
    again = _try(client, juno, SPAWN)   # a retry waits on the same request: one per mind and skill
    assert again["approval_id"] == request["id"] and len(_grants(hive, juno)) == 1
    answered = _answer(client, request["id"], "always")
    assert answered.status_code == 200, answered.text
    assert _try(client, juno, SPAWN) == {"decision": "allow"}
    rule = hive.db.one("SELECT * FROM policy_rules WHERE scope = ? AND skill = 'code-mind-spawn' AND mode = 'allow'",
                       (f"agent:{juno['id']}",))
    assert rule is not None and rule["origin"] == "answer"


def test_for_a_time_allows_it_until_its_rule_ends(client):
    hive, juno = _juno(client)
    request = _try(client, juno, SPAWN)
    assert _answer(client, request["approval_id"], "for", minutes=5).status_code == 200
    assert _try(client, juno, SPAWN) == {"decision": "allow"}
    rule = hive.db.one("SELECT * FROM policy_rules WHERE scope = ? AND skill = 'code-mind-spawn'", (f"agent:{juno['id']}",))
    assert rule["mode"] == "allow" and abs(rule["expires_at"] - (time.time() + 300)) < 60


def test_a_permission_is_a_rule_so_once_is_refused_and_the_request_waits(client):
    """The skill's own checks past the gate read rules (the flow and update routes, the Code service), so a one-time
    answer could not carry: Once, by either route, is refused and the request stays open for a rule or a no."""
    hive, juno = _juno(client)
    request = _try(client, juno, SPAWN)
    once = _answer(client, request["approval_id"], "once")
    assert once.status_code == 400 and once.json()["error"]["code"] == "grant_is_a_rule"
    legacy = client.post(f"/api/approvals/{request['approval_id']}/approve", json={})
    assert legacy.status_code == 400 and legacy.json()["error"]["code"] == "grant_is_a_rule"
    assert hive.db.one("SELECT status FROM approvals WHERE id = ?", (request["approval_id"],))["status"] == "pending"
    assert _answer(client, request["approval_id"], "no").status_code == 200
    assert [r["status"] for r in _grants(hive, juno)] == ["denied"]


def test_never_ends_the_requests_for_that_skill(client):
    hive, juno = _juno(client)
    request = _try(client, juno, SPAWN)
    assert _answer(client, request["approval_id"], "never").status_code == 200
    refused = _try(client, juno, SPAWN)
    assert refused["decision"] == "deny" and refused["message"].startswith("HIVE-DENIED code-mind-spawn")
    assert [r["status"] for r in _grants(hive, juno)] == ["denied"]


def test_a_refusal_someone_chose_stays_a_plain_refusal_with_nothing_filed(client):
    hive, juno = _juno(client)
    # an admin's hive-wide rule and a mind's own rule (as a role or a member writes one): their call, not a gap
    assert client.post("/api/policy", json={"scope": "hive", "skill": "web-search", "mode": "deny"}).status_code == 200
    assert client.post("/api/policy", json={"scope": f"agent:{juno['id']}", "skill": "web-*", "mode": "deny"}).status_code == 200
    for command in ('(web-search "sourdough proofing times")', '(web-fetch "https://example.org")'):
        refused = _try(client, juno, command)
        assert refused["decision"] == "deny" and refused["message"].startswith("HIVE-DENIED "), command
    human = _try(client, juno, '(transfer-funds "rosa" "100")')
    assert human["decision"] == "deny" and "human-only" in human["message"]
    # a mind holding one of the hive's own roles: the request helper's limits are the hive's design, so even an
    # explicit-only skill is not asked for
    helper_role = hive.foundation.helper_role()
    helper = hive.create_agent("Helper", "omega", juno["swarm_id"], "mock/echo", "", None, 0, None, helper_role["id"])
    assert _try(client, helper, SPAWN)["decision"] == "deny"
    assert _grants(hive, juno) == [] and _grants(hive, helper) == []


def test_only_a_hive_admin_answers_a_permission_request(client):
    hive = client.app.state.hive
    ines = person(client, "u_ines_perm", "member")
    hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                    (time.time() + 3600, token_hash(ines["Authorization"].split(" ", 1)[1])))
    made = client.post("/api/agents", headers=ines, json={"name": "Ines's mind", "kind": "module", "visibility": "public"})
    assert made.status_code == 200, made.text
    mind = made.json()
    request = _try(client, mind, SPAWN)
    assert request["decision"] == "pending"
    listed = [a for a in client.get("/api/approvals", headers=ines).json() if a["id"] == request["approval_id"]]
    assert listed and listed[0]["kind"] == "grant" and listed[0]["may_answer"] is False   # she owns the mind, not the hive
    refused = client.post(f"/api/approvals/{request['approval_id']}/decide", headers=ines, json={"decision": "always"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "admin_only"
    assert hive.db.one("SELECT status FROM approvals WHERE id = ?", (request["approval_id"],))["status"] == "pending"
    assert _answer(client, request["approval_id"], "always").status_code == 200
    assert hive.policy.decide(mind, "code-mind-spawn")[0] == "allow"                     # the admin's answer applied


def test_a_routes_own_check_files_the_same_request_and_honours_its_answer(client):
    """A client calling a route directly (an outside member through the MCP bridge) meets Policy.enforce, which files
    the same request and honours the admin's rule."""
    hive, juno = _juno(client)
    with pytest.raises(HiveError) as refused:
        hive.policy.enforce(juno, "code-mind-spawn", SPAWN)
    assert refused.value.code == "approval_required"
    [request] = _grants(hive, juno)
    assert _answer(client, request["id"], "always").status_code == 200
    assert hive.policy.enforce(juno, "code-mind-spawn", SPAWN) is None
