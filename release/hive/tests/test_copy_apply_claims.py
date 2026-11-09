"""Linkage slice 3: the host side of Code's workspace copy-apply flow (PLATFORM_COPY_APPLY_AUTHORITY_ANSWER_20261007 §2).

The copy_apply purpose branch of POST /api/agent/code/capability (issuance checks 1-6, claims, exclusivity, idempotency,
off by default), its live status through GET /api/services/capabilities/{id}, the held copy-apply relay entries, and
Programs.pinned_release. Synthetic only: fake supervisor, mock models, a fake Code transport; no provider calls."""
import asyncio
import datetime
import hashlib
import importlib
import json
import os
import pathlib
import re
import sys

import httpx
import pytest

from hive.core import code as code_module
from hive.core.code import (COPY_APPLY_PERSON_ROUTES, COPY_APPLY_PURPOSE_ROUTES, COPY_APPLY_ROUTES, HUMAN_ACTIONS, HUMAN_ONLY_ROUTES,
                            PROXY_ROUTES, copy_apply_route)
from hive.core.db import now
from hive.core.services import ACTIONS, COPY_APPLY_ACTIONS, DELEGATED_ACTIONS
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import accepted, enabled, later, person, service, spawn, w  # noqa: F401  (fixture)

WS = "ws_" + "a1" * 16
SCOPE_DIGEST = "sha256:" + "cd" * 32
SUGGESTION = "suggestion_" + "0f" * 16
SUGGESTION_DIGEST = "ee" * 32
TREE = "77" * 32
CAP = "/api/agent/code/capability"
CLAIM_KEYS = {"id", "iss", "aud", "actor", "kind", "task_id", "swarm_id", "repository_id", "actions", "paths", "argv_prefixes",
              "iat", "exp", "max_runs", "max_runtime_seconds", "member_hash", "grant_id", "copy_apply",
              "copy_apply_consent"}
CONSENT_CLAIM = {"consent_id": "cns_" + "ab" * 16, "accepted_at": "2026-10-09T00:00:00.000Z"}


def origin(w, **over):
    return {"task_id": w.task["id"], "repository_id": "synthetic", "workspace_id": WS, "scope_id": "scope_1",
            "scope_digest": SCOPE_DIGEST, "generation": 1} | over


def request(w, **over):
    return accepted(w, origin=origin(w), **over)


def body(rq, op="op-capply-0001", **over):
    inner = {"operation_id": op, "request_id": rq["request_id"],
             "proposal": {"suggestion_id": SUGGESTION, "suggestion_digest": SUGGESTION_DIGEST},
             "expected": {"generation": 1, "tree_digest": TREE}}
    inner.update(over)
    return {"service": "omegacode", "copy_apply": inner}


@pytest.fixture()
def cw(w, monkeypatch):
    monkeypatch.setattr(type(w.hive.code), "_loaded_release_mismatch", lambda self: None)   # no Code LaunchAgent in tests
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset())   # relay-proof transport: interop tests
    w.svc = service(w)
    w.hive.settings.copy_apply_claims = True
    return w


ORIGIN = {"Origin": "http://127.0.0.1:8700"}


def consent(w, rq, suggestion_id=SUGGESTION, suggestion_digest=SUGGESTION_DIGEST, decision="accept", who=None):
    """copy-apply consent r1: the request's person accepts (after Accept + confirm) or declines one exact proposal."""
    return w.client.post(f"/api/requests/{rq['request_id']}/proposals/{suggestion_id}/{decision}",
                         headers={**(who or w.jon), **ORIGIN}, json={"suggestion_digest": suggestion_digest})


def issue(w, rq, agent=None, consented=True, **over):
    """The controller's issue; by default the request's person has first accepted that exact proposal (consent r1)."""
    if consented:
        proposal = over.get("proposal") or {}
        if isinstance(proposal, dict) and "request_id" in rq:
            consent(w, rq, proposal.get("suggestion_id", SUGGESTION), proposal.get("suggestion_digest", SUGGESTION_DIGEST))
    return w.client.post(CAP, headers=agent_headers(agent or w.ctl), json=body(rq, **over))


def status(w, cap_id):
    out = w.client.get(f"/api/services/capabilities/{cap_id}", headers=w.svc)
    assert out.status_code == 200, out.text
    return out.json()


def error(out):
    return out.json()["error"]


def written(hive):
    return {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("capabilities", "mind_operations", "copy_apply_bindings")}


# ---- off by default -----------------------------------------------------------------------------------------

def test_copy_apply_is_off_by_default_and_refuses_before_anything_is_written(w):
    service(w)
    assert w.hive.settings.copy_apply_claims is False
    rq = accepted(w, origin=origin(w))
    before = written(w.hive)
    out = w.client.post(CAP, headers=agent_headers(w.ctl), json=body(rq))
    assert out.status_code == 503 and error(out)["code"] == "copy_apply_off"
    assert written(w.hive) == before


def test_the_switch_is_exactly_on_in_the_launcher_environment(monkeypatch, tmp_path):
    from hive.core.config import load_settings
    for value, expected in (("on", True), ("1", False), ("true", False), ("", False)):
        monkeypatch.setenv("HIVE_COPY_APPLY_CLAIMS", value)
        assert load_settings(data_dir=tmp_path).copy_apply_claims is expected, value


# ---- issuance and claims --------------------------------------------------------------------------------------

def test_the_controller_gets_the_exact_purpose_claims(cw):
    rq = request(cw)
    out = issue(cw, rq)
    assert out.status_code == 200, out.text
    claims = out.json()["claims"]
    assert set(claims) == CLAIM_KEYS
    assert (claims["iss"], claims["aud"], claims["actor"], claims["kind"]) == ("hive", "svc_code", cw.ctl["id"], "agent")
    assert (claims["task_id"], claims["swarm_id"], claims["repository_id"]) == (cw.task["id"], cw.origin["id"], "synthetic")
    assert claims["actions"] == ["proposal-apply"] and claims["paths"] == [] and claims["argv_prefixes"] == []
    assert claims["max_runs"] == 0 and claims["max_runtime_seconds"] == 0
    assert claims["grant_id"] == cw.grant["id"]                                   # kept, never null: grant revocation reaches it
    assert claims["member_hash"] == hashlib.sha256(cw.ctl["token"].encode()).hexdigest()
    assert 0 < claims["exp"] - claims["iat"] <= 300
    assert claims["copy_apply"] == {
        "purpose": "workspace-copy-apply", "operation_id": "op-capply-0001", "request_id": rq["request_id"],
        "lease_id": rq["lease_id"], "controller_id": cw.ctl["id"], "execution_goal": rq["receiving_goal"], "issuer": "user:u_jon",
        "origin_grant_id": cw.grant["id"],
        "origin": {"task_id": cw.task["id"], "repository_id": "synthetic", "workspace_id": WS, "scope_id": "scope_1",
                   "scope_digest": SCOPE_DIGEST},
        "proposal": {"suggestion_id": SUGGESTION, "suggestion_digest": SUGGESTION_DIGEST},
        "expected": {"generation": 1, "tree_digest": TREE}}
    st = status(cw, claims["id"])
    assert st["active"] is True and st["reason"] is None and st["claims"] == claims
    assert st["copy_apply_status"] == {"request_open": True, "lease_live": True, "controller_current": True}
    token = out.json()["token"]
    assert token.startswith("hc1.")


def test_expiry_is_the_lease_end_when_that_comes_first(cw):
    rq = request(cw)
    until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=90)
    stamp = until.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    cw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (stamp, rq["lease_id"]))
    claims = issue(cw, rq).json()["claims"]
    assert claims["exp"] == int(until.timestamp()) and claims["exp"] - claims["iat"] <= 90


def test_replay_returns_the_same_binding_with_a_fresh_token_and_one_live_capability(cw):
    rq = request(cw)
    first = issue(cw, rq).json()
    again = issue(cw, rq).json()
    assert again["claims"]["copy_apply"] == first["claims"]["copy_apply"]
    assert again["claims"]["id"] != first["claims"]["id"] and again["token"] != first["token"]
    assert status(cw, first["claims"]["id"])["reason"] == "revoked"
    assert status(cw, again["claims"]["id"])["active"] is True
    assert cw.hive.db.one("SELECT COUNT(*) AS n FROM mind_operations WHERE scope = ?", (f"capply:{cw.ctl['id']}",))["n"] == 1
    changed = issue(cw, rq, expected={"generation": 2, "tree_digest": TREE})
    assert changed.status_code == 409 and error(changed)["code"] == "operation_conflict"


def test_one_binding_per_proposal(cw):
    rq = request(cw)
    assert issue(cw, rq).status_code == 200
    other_op = issue(cw, rq, op="op-capply-0002")
    assert other_op.status_code == 409 and error(other_op)["code"] == "binding_exists"
    other = issue(cw, rq, op="op-capply-0003", proposal={"suggestion_id": "suggestion_" + "1a" * 16,
                                                         "suggestion_digest": SUGGESTION_DIGEST})
    assert other.status_code == 200, other.text


@pytest.mark.parametrize("over", [
    {"operation_id": "short"},
    {"request_id": "nope"},
    {"proposal": {"suggestion_id": "suggestion_" + "0F" * 16, "suggestion_digest": SUGGESTION_DIGEST}},
    {"proposal": {"suggestion_id": SUGGESTION, "suggestion_digest": "sha256:" + SUGGESTION_DIGEST}},
    {"proposal": {"suggestion_id": SUGGESTION, "suggestion_digest": SUGGESTION_DIGEST, "extra": 1}},
    {"proposal": {"suggestion_id": SUGGESTION}},
    {"expected": {"generation": 0, "tree_digest": TREE}},
    {"expected": {"generation": True, "tree_digest": TREE}},
    {"expected": {"generation": "1", "tree_digest": TREE}},
    {"expected": {"generation": 1, "tree_digest": "sha256:" + TREE}},
    {"origin": {"task_id": "g_other"}},                          # check 5: origin never comes from the body
])
def test_check_6_body_values_match_their_patterns_and_refusals_write_nothing(cw, over):
    rq = request(cw)
    before = written(cw.hive)
    out = issue(cw, rq, **over)
    assert out.status_code == 400 and error(out)["code"] == "bad_request", out.text
    assert written(cw.hive) == before


def test_closed_outer_body(cw):
    rq = request(cw)
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json=body(rq) | {"task_id": cw.task["id"]})
    assert out.status_code == 400
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json=body(rq) | {"service": "other"})
    assert out.status_code == 400
    inner = body(rq)["copy_apply"]
    del inner["expected"]
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json={"copy_apply": inner})
    assert out.status_code == 400 and "expected" in error(out)["message"]


def test_check_1_a_delegated_child_is_never_the_controller(cw):
    enabled(cw)
    rq = request(cw)
    child = spawn(cw, rq["request_id"]).json()["child_id"]
    out = cw.client.post(CAP, headers={"Authorization": f"Bearer {cw.tokens[child]}"}, json=body(rq))
    assert out.status_code == 403 and error(out)["code"] == "not_controller"
    assert error(out)["reason"] == "delegated_child"


def test_check_2_only_the_requests_current_controller(cw):
    rq = request(cw)
    for agent in (cw.helper, cw.fctl):
        out = issue(cw, rq, agent=agent)
        assert out.status_code == 403 and error(out)["code"] == "not_controller"
    cw.client.patch(f"/api/swarms/{cw.team['id']}", json={"coordinator_id": cw.helper["id"]})   # no longer in controllers(team)
    out = issue(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "not_controller"
    missing = cw.client.post(CAP, headers=agent_headers(cw.ctl), json=body({"request_id": "rq_missing"}))
    assert missing.status_code == 404


def test_check_3_request_and_lease_live(cw):
    rq = request(cw)
    cw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
    out = issue(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "lease_required"
    cw.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=cw.jon)
    out = issue(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "request_closed"


def test_check_3_a_lease_whose_issuer_lost_admin_is_not_live(cw):
    rq = request(cw)
    cw.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_jon'")
    out = issue(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "lease_required"


def test_check_4_a_read_origin_grant_is_never_raised_to_edit(cw):
    cw.hive.services.revoke_grant(cw.task["id"], cw.grant["id"])
    cw.hive.services.grant(cw.task["id"], "user:u_jon", "read", None, 120, by="user:u_jon")
    rq = request(cw)                                  # an instruction under a read grant is accepted ...
    out = issue(cw, rq)                               # ... and still gives no copy authority
    assert out.status_code == 403 and error(out)["code"] == "origin_grant_read_only"


def test_check_4_the_edit_grant_covers_the_origin_workspace(cw):
    cw.hive.services.revoke_grant(cw.task["id"], cw.grant["id"])
    cw.hive.services.grant(cw.task["id"], "user:u_jon", "edit", "ws_" + "b2" * 16, 120, by="user:u_jon")
    rq = request(cw)
    out = issue(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "origin_grant_read_only"


def test_check_4_withdrawn_grant_and_closed_origin_task(cw):
    rq = request(cw)
    cw.hive.db.execute("UPDATE goals SET status = 'done' WHERE id = ?", (cw.task["id"],))
    out = issue(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "task_closed"
    cw.hive.db.execute("UPDATE goals SET status = 'open' WHERE id = ?", (cw.task["id"],))
    cw.hive.services.revoke_grant(cw.task["id"], cw.grant["id"])
    out = issue(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "grant_withdrawn"


def test_check_6_a_host_origin_that_is_not_a_code_workspace_scope_is_refused(cw):
    rq = accepted(cw, origin=origin(cw, workspace_id="ws_1"))
    out = issue(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "origin_invalid"
    rq = accepted(cw, operation_id="op-request-2", origin=origin(cw, workspace_id="ws_" + "A1" * 16))   # uppercase: not Code's id
    out = issue(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "origin_invalid"


# ---- exclusivity and the action vocabulary -----------------------------------------------------------------------

@pytest.mark.parametrize("other", [{"delegated": True}, {"proposal_test": {}}])
def test_purpose_branches_are_mutually_exclusive(cw, other):
    rq = request(cw)
    before = written(cw.hive)
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json=body(rq) | other)
    assert out.status_code == 400 and error(out)["code"] == "purpose_exclusive"
    assert written(cw.hive) == before


def test_services_issue_keeps_proposal_apply_to_the_copy_apply_branch(cw):
    svc = cw.hive.services
    common = dict(actor=cw.ctl["id"], kind="agent", task_id=cw.task["id"], swarm_id=cw.origin["id"], repository_id="synthetic",
                  member_token="t")
    assert "proposal-apply" not in ACTIONS and "proposal-apply" not in DELEGATED_ACTIONS and COPY_APPLY_ACTIONS == {"proposal-apply"}
    for extra in ({}, {"delegated": {"request_id": "rq_x"}}):
        with pytest.raises(Exception) as refused:
            svc.issue("svc_code", actions=["proposal-apply"], **common, **extra)
        assert refused.value.code == "bad_actions"
    purpose = dict(copy_apply={"purpose": "workspace-copy-apply"}, copy_apply_consent=CONSENT_CLAIM, grant_id=cw.grant["id"], max_runs=0, max_runtime_seconds=0,
                   exp=int(datetime.datetime.now().timestamp()) + 60)
    with pytest.raises(Exception) as refused:
        svc.issue("svc_code", actions=["proposal-apply", "edit"], **common, **purpose)
    assert refused.value.code == "bad_actions"
    with pytest.raises(Exception) as refused:
        svc.issue("svc_code", actions=["proposal-apply"], **common, **(purpose | {"max_runs": 20}))
    assert refused.value.code == "bad_purpose"
    with pytest.raises(Exception) as refused:
        svc.issue("svc_code", actions=["proposal-apply"], **common, **(purpose | {"delegated": {"request_id": "rq_x"}}))
    assert refused.value.code == "purpose_exclusive"


def test_ordinary_issuance_refuses_proposal_apply(cw):
    goal = asyncio.run(cw.hive.goals.create(cw.team["id"], "Own goal", created_by="user:u_jon"))
    claim = cw.client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(cw.ctl))
    assert claim.status_code == 200, claim.text
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json={"task_id": goal["id"], "actions": ["proposal-apply"]})
    assert out.status_code == 400 and error(out)["code"] == "bad_actions"
    out = cw.client.post("/api/code/capability", json={"task_id": cw.task["id"], "grant_id": None, "actions": ["proposal-apply"]})
    assert out.status_code == 400 and error(out)["code"] == "bad_actions"
    assert "proposal-apply" not in HUMAN_ACTIONS
    with pytest.raises(code_module.CodeError) as refused:
        cw.hive.code._capability("user:u_jon", cw.task["id"], cw.grant["id"], "synthetic", ("proposal-apply",))
    assert refused.value.code == "route_actions_invalid"


# ---- live status ---------------------------------------------------------------------------------------------

def test_revoking_the_lease_grant_revokes_the_capability(cw):
    rq = request(cw)
    claims = issue(cw, rq).json()["claims"]
    cw.hive.services.revoke_grant(cw.task["id"], cw.grant["id"])
    st = status(cw, claims["id"])
    assert st["active"] is False and st["reason"] == "revoked"


@pytest.mark.parametrize("withdraw,reason,flags", [
    (lambda w, rq: w.client.patch(f"/api/swarms/{w.team['id']}", json={"coordinator_id": w.helper["id"]}), "not_controller",
     {"controller_current": False}),
    (lambda w, rq: w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.jon), "request_closed",
     {"request_open": False, "lease_live": False}),        # cancelling a request also ends its lease
    (lambda w, rq: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"])),
     "lease_expired", {"lease_live": False}),
    (lambda w, rq: w.hive.db.execute("UPDATE goal_grants SET scope = 'read' WHERE id = ?", (w.grant["id"],)),
     "origin_grant_read_only", {}),
    (lambda w, rq: w.hive.db.execute("UPDATE goal_grants SET workspace_id = ? WHERE id = ?", ("ws_" + "b2" * 16, w.grant["id"])),
     "origin_grant_read_only", {}),
    (lambda w, rq: w.hive.db.execute("UPDATE goal_grants SET revoked_at = ? WHERE id = ?", (now(), w.grant["id"])),
     "grant_withdrawn", {}),
    (lambda w, rq: w.hive.db.execute("UPDATE goals SET status = 'cancelled' WHERE id = ?", (w.task["id"],)), "task_closed", {}),
])
def test_status_withdraws_with_the_purpose_reason(cw, withdraw, reason, flags):
    rq = request(cw)
    claims = issue(cw, rq).json()["claims"]
    withdraw(cw, rq)
    st = status(cw, claims["id"])
    assert st["active"] is False and st["reason"] == reason
    assert st["copy_apply_status"] == {"request_open": True, "lease_live": True, "controller_current": True} | flags


def test_generic_reasons_come_before_purpose_reasons(cw):
    rq = request(cw)
    claims = issue(cw, rq).json()["claims"]
    cw.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=cw.jon)
    cw.hive.services.revoke_capability(claims["id"])
    st = status(cw, claims["id"])
    assert st["reason"] == "revoked" and st["copy_apply_status"]["request_open"] is False


def test_status_is_only_for_the_service_and_ordinary_capabilities_carry_no_copy_status(cw):
    rq = request(cw)
    claims = issue(cw, rq).json()["claims"]
    assert cw.client.get(f"/api/services/capabilities/{claims['id']}", headers=agent_headers(cw.ctl)).status_code == 401
    plain = cw.hive.services.issue("svc_code", actor="user:u_jon", kind="human", task_id=cw.task["id"], swarm_id=cw.origin["id"],
                                   repository_id="synthetic", actions=["read"], grant_id=cw.grant["id"])
    assert "copy_apply_status" not in status(cw, plain["claims"]["id"])


# ---- relay entries -------------------------------------------------------------------------------------------

APP = f"/v1/workspaces/{WS}/proposal-applications/application_{'3c' * 16}"


def test_relay_action_mapping_is_codes_direction():
    assert COPY_APPLY_PERSON_ROUTES == [
        ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications/application_[a-f0-9]{32}$", ("read",)),
        ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications/application_[a-f0-9]{32}/undo$", ("edit",))]
    assert HUMAN_ONLY_ROUTES == {COPY_APPLY_PERSON_ROUTES[1][1]}
    assert set(COPY_APPLY_PURPOSE_ROUTES) == {
        ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications$", ("proposal-apply",)),
        ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications/application_[a-f0-9]{32}$", ("proposal-apply",))}
    assert code_module.purpose_route("copy_apply", "POST", f"/v1/workspaces/{WS}/proposal-applications")
    assert code_module.purpose_route("copy_apply", "POST", APP + "/undo") is None          # Undo is never the controller's
    for method, pattern, actions in PROXY_ROUTES + COPY_APPLY_PERSON_ROUTES:
        assert set(actions) <= set(HUMAN_ACTIONS) and "proposal-apply" not in actions, (method, pattern)
    # the ordinary relay has none of them while they are held
    for method, path in (("GET", APP), ("POST", APP + "/undo"), ("POST", f"/v1/workspaces/{WS}/proposal-applications")):
        assert not any(r[0] == method and re.fullmatch(r[1], path) for r in PROXY_ROUTES)



class FakeCode:
    def __init__(self):
        self.calls = []

    async def request(self, method, url, params=None, content=None, headers=None, timeout=None):
        token = headers["Authorization"].split()[1]
        payload = token.split(".")[1]
        claims = json.loads(__import__("base64").urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        self.calls.append((method, url, claims))
        return httpx.Response(200, json={"ok": True})


@pytest.fixture()
def relay(cw, monkeypatch):
    fake = FakeCode()
    monkeypatch.setattr(cw.hive.code, "client", fake)
    cw.fake = fake
    return cw


def proxied(w, method, path, grant_id, headers=None):
    query = {"task_id": w.task["id"], "repository_id": "synthetic"} | ({"grant_id": grant_id} if grant_id else {})
    return w.client.request(method, "/api/code/proxy" + path, params=query, json={} if method == "POST" else None,
                            headers=headers if headers is not None else w.jon)


def test_held_routes_are_not_relayed_while_off_and_the_person_never_applies(relay):
    relay.hive.settings.copy_apply_claims = False
    for method, path in (("GET", APP), ("POST", APP + "/undo")):
        out = proxied(relay, method, path, relay.grant["id"])
        assert out.status_code == 404 and error(out)["code"] == "not_relayed", path
    for on in (False, True):
        relay.hive.settings.copy_apply_claims = on
        out = proxied(relay, "POST", f"/v1/workspaces/{WS}/proposal-applications", relay.grant["id"])
        assert out.status_code == 403 and error(out)["code"] == "purpose_only"
    assert relay.fake.calls == []


def test_person_get_application_relays_with_read_only(relay):
    out = proxied(relay, "GET", APP, relay.grant["id"])
    assert out.status_code == 200, out.text
    method, url, claims = relay.fake.calls[-1]
    assert method == "GET" and url.endswith(APP)
    assert claims["kind"] == "human" and claims["actions"] == ["read"] and "copy_apply" not in claims


def test_person_undo_relays_with_edit_on_the_persons_own_edit_grant(relay):
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 200, out.text
    _, url, claims = relay.fake.calls[-1]
    assert url.endswith(APP + "/undo") and claims["kind"] == "human" and claims["actions"] == ["edit"]
    assert claims["actor"] == "user:u_jon" and claims["grant_id"] == relay.grant["id"]


def test_undo_is_human_only_and_path_scoped(relay):
    calls = len(relay.fake.calls)
    out = proxied(relay, "POST", APP + "/undo", None, headers={})            # the operator login without a grant
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    read = relay.hive.services.grant(relay.task["id"], "user:u_jon", "read", None, 120)
    out = proxied(relay, "POST", APP + "/undo", read["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    other = relay.hive.services.grant(relay.task["id"], "user:u_jon", "edit", "ws_" + "b2" * 16, 120)
    out = proxied(relay, "POST", APP + "/undo", other["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    assert len(relay.fake.calls) == calls


# ---- Code's own validator accepts the host claims (when Code's r7 candidate source is on this machine) -----------

R7_SRC = os.environ.get("OMEGACODE_R7_SRC", os.path.join(os.path.expanduser("~"), "OmegaDot", ".runtime", "omegacode",
                                                          "r7-installed-candidate-20261007", "git-staging", "omegacode", "src"))


def test_codes_r7_binding_validator_accepts_the_issued_claims_and_live_status(cw):
    if not (pathlib.Path(R7_SRC) / "omegacode" / "copy_binding.py").is_file():
        pytest.skip("Code r7 candidate source not on this machine")
    saved = {k: v for k, v in sys.modules.items() if k == "omegacode" or k.startswith("omegacode.")}
    for k in saved:
        del sys.modules[k]
    sys.path.insert(0, R7_SRC)
    try:
        validate = importlib.import_module("omegacode.copy_binding").validate_binding
        rq = request(cw)
        claims = issue(cw, rq).json()["claims"]
        principal = type("P", (), {"operator": False, "actor": cw.ctl["id"], "grant": claims, "hive_token": cw.ctl["token"]})()
        workspace = {"id": WS, "task_id": cw.task["id"], "swarm_id": cw.origin["id"], "repository_id": "synthetic"}
        payload = {"operation_id": "op-capply-0001", "request_id": rq["request_id"], "suggestion_id": SUGGESTION,
                   "suggestion_digest": SUGGESTION_DIGEST, "expected_generation": 1, "expected_tree_digest": TREE,
                   "scope_id": "scope_1", "scope_digest": SCOPE_DIGEST}
        assert validate(principal, workspace, payload, audience="svc_code", status_reader=lambda i: status(cw, i)) is True
        cw.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=cw.jon)
        with pytest.raises(Exception) as refused:
            validate(principal, workspace, payload, audience="svc_code", status_reader=lambda i: status(cw, i))
        assert refused.value.code == "host_capability_inactive"
    finally:
        sys.path.remove(R7_SRC)
        for k in [k for k in sys.modules if k == "omegacode" or k.startswith("omegacode.")]:
            del sys.modules[k]
        sys.modules.update(saved)


# ---- Programs.pinned_release -----------------------------------------------------------------------------------

def test_pinned_release_is_none_for_unknown_or_unpinned_apps(client):  # noqa: F811
    programs = client.app.state.hive.programs
    assert programs.pinned_release("no-such-app") is None
    for pid in list(programs.programs)[:3]:
        if pid not in (programs.pins or {}):
            assert programs.pinned_release(pid) is None


# ---- Kimi s3-b40fa13 FIX-FIRST round ---------------------------------------------------------------------------

def test_one_declared_route_table_decides_relay_held_and_purpose_only():
    """#5: the 403-vs-404 decision comes from COPY_APPLY_ROUTES alone; the list views are derived from it."""
    assert len({(r["method"], r["pattern"]) for r in COPY_APPLY_ROUTES}) == len(COPY_APPLY_ROUTES) == 3
    assert COPY_APPLY_PERSON_ROUTES == [(r["method"], r["pattern"], r["person"]) for r in COPY_APPLY_ROUTES if r["person"]]
    assert HUMAN_ONLY_ROUTES == {r["pattern"] for r in COPY_APPLY_ROUTES if r["human_only"]}
    apps = f"/v1/workspaces/{WS}/proposal-applications"
    expect = {("GET", APP): ("held", "relay"), ("POST", APP + "/undo"): ("held", "relay"),
              ("POST", apps): ("purpose_only", "purpose_only")}
    for (method, path), (off, on) in expect.items():
        assert copy_apply_route(method, path, False)[0] == off and copy_apply_route(method, path, True)[0] == on, path
    assert copy_apply_route("GET", f"/v1/workspaces/{WS}/files", True) == (None, None)       # ordinary routes are untouched
    assert copy_apply_route("POST", APP, True) == (None, None)
    for r in COPY_APPLY_ROUTES:                                     # a purpose-only route is never a human route
        assert r["person"] is not None or not r["human_only"]


def test_undo_carries_the_grants_stored_path_scope_into_the_claim(relay):
    """#1: never paths=None for a path-scoped grant. goal_grants keeps no path column on this host, so the test adds one."""
    relay.hive.db.execute("ALTER TABLE goal_grants ADD COLUMN paths TEXT")
    relay.hive.db.execute("UPDATE goal_grants SET paths = ? WHERE id = ?", (json.dumps(["src/calc.py", "docs"]), relay.grant["id"]))
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 200, out.text
    assert relay.fake.calls[-1][2]["paths"] == ["docs", "src/calc.py"]
    relay.hive.db.execute("UPDATE goal_grants SET paths = ? WHERE id = ?", ("not json", relay.grant["id"]))
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"


def test_undo_on_a_whole_repository_grant_keeps_the_whole_repository_scope(relay):
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 200 and relay.fake.calls[-1][2]["paths"] == []


@pytest.mark.parametrize("spoil", [
    lambda w: w.hive.db.execute("UPDATE goal_grants SET revoked_at = ? WHERE id = ?", (now(), w.grant["id"])),
    lambda w: w.hive.db.execute("UPDATE goal_grants SET expires_at = 0 WHERE id = ?", (w.grant["id"],)),
    lambda w: w.hive.db.execute("UPDATE goal_grants SET principal = 'user:u_ann' WHERE id = ?", (w.grant["id"],)),
    lambda w: w.hive.db.execute("UPDATE goal_grants SET goal_id = 'g_other' WHERE id = ?", (w.grant["id"],)),
    lambda w: w.hive.db.execute("UPDATE goal_grants SET scope = 'read' WHERE id = ?", (w.grant["id"],)),
    lambda w: w.hive.db.execute("UPDATE goal_grants SET workspace_id = ? WHERE id = ?", ("ws_" + "b2" * 16, w.grant["id"])),
])
def test_every_undo_grant_refusal_is_edit_grant_required(relay, spoil):
    """#4: the full active-edit-grant predicate is the Undo check, so no stale grant reaches the generic grant_invalid."""
    spoil(relay)
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    assert relay.fake.calls == []


def test_a_cached_ordinary_read_token_is_never_reused_for_a_copy_apply_route(relay):
    assert proxied(relay, "GET", f"/v1/workspaces/{WS}", relay.grant["id"]).status_code == 200
    assert proxied(relay, "GET", APP, relay.grant["id"]).status_code == 200
    ordinary, copy = relay.fake.calls[-2][2], relay.fake.calls[-1][2]
    assert ordinary["actions"] == copy["actions"] == ["read"] and ordinary["id"] != copy["id"]


R7_SERVICE = os.environ.get("OMEGACODE_R7_SERVICE", "")   # Code r7 service source, supplied explicitly; else skipped


def test_undo_mints_exactly_the_actions_codes_r7_undo_authorizes():
    """#2: Code r7's undo authorizes through service.edit's default _action "edit" only, with kind human; no read check."""
    import ast
    root = pathlib.Path(R7_SERVICE) if R7_SERVICE else None
    if root is None or not (root / "copy_application.py").is_file():
        pytest.skip("Code r7 service source not on this machine")
    tree = ast.parse((root / "copy_application.py").read_text())
    undo = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "undo")
    calls = [n for n in ast.walk(undo) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
    authorized = {c.args[1].value for c in calls if c.func.attr in ("_authorize", "_operation") and len(c.args) > 1
                  and isinstance(c.args[1], ast.Constant)}
    edits = [c for c in calls if c.func.attr == "edit"]
    assert authorized == set() and len(edits) == 1 and not any(k.arg == "_action" for k in edits[0].keywords)
    service = ast.parse((root / "service.py").read_text())
    edit = next(n for n in ast.walk(service) if isinstance(n, ast.FunctionDef) and n.name == "edit")
    defaults = {a.arg: d.value for a, d in zip(edit.args.kwonlyargs, edit.args.kw_defaults) if isinstance(d, ast.Constant)}
    assert defaults["_action"] == "edit"
    undo_entry = next(r for r in COPY_APPLY_ROUTES if r["pattern"].endswith("/undo$"))
    assert set(undo_entry["person"]) == {defaults["_action"]} and undo_entry["human_only"]


@pytest.mark.parametrize("stored", ["", "[]", [], "   ", "[\"\"]", "null"])
def test_a_blank_or_empty_stored_path_scope_is_refused_never_widened(relay, stored):
    """Stand-in 3a57b86 #1: only a missing/None scope is whole-repository; a blank or empty stored scope refuses."""
    relay.hive.db.execute("ALTER TABLE goal_grants ADD COLUMN paths TEXT")
    value = json.dumps(stored) if isinstance(stored, list) else stored      # sqlite stores the list as its JSON text
    relay.hive.db.execute("UPDATE goal_grants SET paths = ? WHERE id = ?", (value, relay.grant["id"]))
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    assert relay.fake.calls == []


@pytest.mark.parametrize("stored", ["", "[]", []])
def test_grant_path_scope_helper_refuses_blank_and_empty_and_keeps_missing_as_whole_repository(stored):
    with pytest.raises(code_module.CodeError) as refused:
        code_module.grant_path_scope({"paths": stored})
    assert refused.value.code == "edit_grant_required"
    assert code_module.grant_path_scope({}) is None and code_module.grant_path_scope({"paths": None}) is None
    assert code_module.grant_path_scope({"paths": ["b", "a"]}) == ["a", "b"]


BAD_PATHS = {"absolute": "/absolute", "dotdot": "../outside", "inner_dotdot": "src/../../outside", "nul": "a\u0000b",
             "control": "a\u0007b", "newline": "src/a.py\n", "delete": "a\u007fb", "backslash": "src\\a.py",
             "empty_segment": "src//a.py", "trailing_slash": "src/", "leading_dot": "./src/a.py", "dot_segment": "src/./a.py",
             "too_long": "a" * 513, "git": ".git/config", "secret": "config/.env", "env_variant": "app/.env.local"}


@pytest.mark.parametrize("name", sorted(BAD_PATHS))
def test_a_malformed_stored_path_entry_refuses_undo_before_issuance_or_transport(relay, name):
    """Stand-in d0d8f19 #1: each entry is checked the way Code's safe_path checks it; zero capabilities, zero transport."""
    relay.hive.db.execute("ALTER TABLE goal_grants ADD COLUMN paths TEXT")
    relay.hive.db.execute("UPDATE goal_grants SET paths = ? WHERE id = ?", (json.dumps(["docs", BAD_PATHS[name]]), relay.grant["id"]))
    before = relay.hive.db.one("SELECT COUNT(*) AS n FROM capabilities")["n"]
    out = proxied(relay, "POST", APP + "/undo", relay.grant["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    assert relay.fake.calls == [] and relay.hive.db.one("SELECT COUNT(*) AS n FROM capabilities")["n"] == before


def test_path_entry_validator_accepts_ordinary_relative_paths():
    for good in ("a", "src/calc.py", "docs/guide/intro.md", "a" * 512, ".github/workflows/ci.yml", "src/.envrc"):
        assert code_module.scoped_path_ok(good), good
    for bad in BAD_PATHS.values():
        assert not code_module.scoped_path_ok(bad), repr(bad)
    assert not code_module.scoped_path_ok(None) and not code_module.scoped_path_ok(3)


def test_services_issue_refuses_a_copy_apply_capability_on_a_read_grant(cw):
    """MISSING-UI B1 r3 #1 defence in depth: Services.issue itself refuses copy_apply unless the lease grant is edit."""
    read = cw.hive.services.grant(cw.task["id"], "user:u_jon", "read", None, 120, by="user:u_jon")
    common = dict(actor=cw.ctl["id"], kind="agent", task_id=cw.task["id"], swarm_id=cw.origin["id"], repository_id="synthetic",
                  member_token="t", actions=["proposal-apply"], max_runs=0, max_runtime_seconds=0,
                  copy_apply={"purpose": "workspace-copy-apply"}, copy_apply_consent=CONSENT_CLAIM, exp=int(datetime.datetime.now().timestamp()) + 60)
    for grant_id in (read["id"], "gr_missing"):
        with pytest.raises(Exception) as refused:
            cw.hive.services.issue("svc_code", grant_id=grant_id, **common)
        assert refused.value.code == "grant_scope"
    assert cw.hive.services.issue("svc_code", grant_id=cw.grant["id"], **common)["claims"]["actions"] == ["proposal-apply"]


def test_a_read_grant_reads_an_application_but_never_undoes_it(relay):
    read = relay.hive.services.grant(relay.task["id"], "user:u_jon", "read", None, 120, by="user:u_jon")
    assert proxied(relay, "GET", APP, read["id"]).status_code == 200
    out = proxied(relay, "POST", APP + "/undo", read["id"])
    assert out.status_code == 403 and error(out)["code"] == "edit_grant_required"
    assert len(relay.fake.calls) == 1
