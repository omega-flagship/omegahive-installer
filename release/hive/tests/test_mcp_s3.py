"""S3, the MCP member bridge (schema s3-r1, seam r2.4 + r2.6): errors, bound results, leases, exact reads, typed requests,
inventory and evidence query.  Synthetic data only; a disposable host per test (L1), plus L0 pieces where noted."""

import copy
import json
import os
import pathlib
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core import mcp
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.goals import binding_digest

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
# Sibling checkouts (not part of this repository): the folder that holds them, by default the one next to this repo.
SIBLINGS = pathlib.Path(__file__).resolve().parents[3]
ATOM = pathlib.Path(os.environ.get("OMEGAATOM_PATH", str(SIBLINGS)))
needs_atom = pytest.mark.skipif(not (ATOM / "omegaatom" / "envelope.py").exists(),
                                reason="needs sibling repo omegaatom (OmegaAtom's validator, not in this repository; set OMEGAATOM_PATH)")
HEX = "a" * 64


class Supervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


@pytest.fixture()
def c(monkeypatch):
    monkeypatch.setenv("OMEGAATOM_PATH", str(ATOM))
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-s3-")), admin_password="pw", petta_path=PETTA,
                             offline=True, base_path="/omegahive")
    with TestClient(create_app(settings, supervisor=Supervisor(), reconcile_seconds=0)) as client:
        client.admin = {"Authorization": "Bearer " + client.post("/api/auth/login", json={"password": "pw"}).json()["token"]}
        client.hive = client.app.state.hive
        yield client


def member(c, swarm, name):
    code = c.post("/api/harness-invites", json={"harness": "mcp", "name": name, "swarm_id": swarm["id"]}, headers=c.admin).json()["code"]
    rpc(c, code, "initialize")
    return code


def swarm(c, name):
    return c.post("/api/swarms", json={"name": name}, headers=c.admin).json()


def rpc(c, code, method, params=None, mid=1):
    return c.post("/omegahive/mcp", json={"jsonrpc": "2.0", "id": mid, "method": method, **({"params": params} if params is not None else {})},
                  headers={"Authorization": f"Bearer {code}"})


def call(c, code, name, args=None):
    """(structuredContent, None) or (None, error data)."""
    body = rpc(c, code, "tools/call", {"name": name, "arguments": args or {}}).json()
    if "error" in body:
        assert body["error"]["code"] == -32000 and set(body["error"]["data"]) >= {"code", "http_status", "message"}
        assert "result" not in body
        return None, body["error"]["data"]
    result = body["result"]
    assert result["isError"] is False and len(result["content"]) == 1 and "\n" not in result["content"][0]["text"]
    return result["structuredContent"], None


def agent_row(c, code):
    return c.hive.harnesses.member(code)


def bound_goal(c, sw, schema=None, **extra):
    binding = {"request_id": "rq_demo", "base_revision": 1, **({"result_schema": schema} if schema else {})}
    return c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "bound", "binding": binding, **extra}, headers=c.admin).json()


SCHEMA = {"type": "object", "additionalProperties": False, "required": ["verdict"], "properties": {"verdict": {"type": "string", "enum": ["pass", "fail"]}}}


# ---- protocol: marker, version, errors, arguments ---------------------------------------------------------

def test_marker_version_listing_and_error_shape(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    init = rpc(c, code, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and init["serverInfo"] == {"name": "omegahive", "version": "0.2.0"}
    listed = rpc(c, code, "tools/list").json()["result"]
    assert listed["_meta"] == {"x-hive-schema": "s3-r1"}
    names = [t["name"] for t in listed["tools"]]
    assert len(names) == len(set(names))
    assert {"hive_goal_result", "hive_goal_get", "hive_goal_heartbeat", "hive_goal_cancel_ack", "hive_exhibit_read", "hive_artifact_read",
            "hive_revision_read", "hive_request", "hive_capabilities", "hive_evidence_query"} <= set(names)
    assert "hive_evidence_publish" not in names                                  # built but gated off
    data, err = call(c, code, "hive_evidence_publish", {"statement": "(--> a b)", "envelope": {}, "idempotency_key": "k"})
    assert data is None and err["code"] == "evidence_publish_gated" and err["http_status"] == 501
    # every tool fails the same way: JSON-RPC -32000, data {code, http_status, message}; none uses isError
    for name, args, want in [("hive_shell", {}, ("unknown_tool", 404)), ("hive_goal_get", {"goal_id": "g_nope"}, ("not_found", 404)),
                             ("hive_goal_claim", {"goal_id": "g_nope"}, ("not_found", 404)), ("hive_inbox", {"after": "x"}, ("bad_request", 400)),
                             ("hive_goal_get", {}, ("bad_request", 400)), ("hive_goal_get", {"goal_id": "g", "x": 1}, ("bad_request", 400))]:
        data, err = call(c, code, name, args)
        assert (err["code"], err["http_status"]) == want, (name, err)
    assert rpc(c, code, "tools/call", {"name": 5}).json()["error"]["data"]["code"] == "bad_request"
    assert rpc(c, code, "tools/call", {"name": "hive_whoami", "arguments": []}).json()["error"]["data"]["code"] == "bad_request"


def test_errors_from_hive_keep_their_contract_names(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    g = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "late"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": g["id"]})
    c.hive.db.update("goals", g["id"], {"deadline_at": "2000-01-01T00:00:00.000Z"})
    _, err = call(c, code, "hive_goal_result", {"goal_id": g["id"], "status": "done", "result": "x"})
    assert (err["code"], err["http_status"]) == ("deadline_passed", 409)             # goal_expired is deadline_passed on the wire


# ---- bound results ----------------------------------------------------------------------------------------

def test_bound_result_needs_top_level_digest_schema_and_claimant(c):
    sw = swarm(c, "Team")
    code, other = member(c, sw, "Claude"), member(c, sw, "Other")
    g = bound_goal(c, sw, SCHEMA)
    call(c, code, "hive_goal_claim", {"goal_id": g["id"]})
    seen, _ = call(c, code, "hive_goal_get", {"goal_id": g["id"]})
    digest = seen["binding_digest"]
    assert digest == binding_digest(seen["binding"]) and seen["result_schema"] == SCHEMA and seen["deadline_at"] is None and "review_by" in seen
    done = {"goal_id": g["id"], "status": "done", "result": "checked"}
    for args, want in [({}, "binding_mismatch"), ({"binding_digest": "sha256:" + HEX}, "binding_mismatch"),
                       ({"binding_digest": digest, "data": {"verdict": "pass", "binding_digest": "sha256:" + HEX}}, "binding_mismatch"),
                       ({"binding_digest": digest}, "schema_invalid"), ({"binding_digest": digest, "data": {"verdict": "maybe"}}, "schema_invalid"),
                       ({"binding_digest": digest, "data": {"verdict": "pass", "extra": 1}}, "schema_invalid")]:
        _, err = call(c, code, "hive_goal_result", {**done, **args})
        assert err["code"] == want, (args, err)
    assert c.hive.goals.get(g["id"])["status"] == "claimed"                              # nothing partial happened
    _, err = call(c, other, "hive_goal_result", {**done, "binding_digest": digest, "data": {"verdict": "pass"}})
    assert err["http_status"] == 403                                                      # not the current claimant
    good = {**done, "binding_digest": digest, "data": {"verdict": "pass"}}
    first, err = call(c, code, "hive_goal_result", good)
    assert err is None and first["status"] == "done" and first["result_data"] == {"proposal": {"verdict": "pass"}}
    again, err = call(c, code, "hive_goal_result", good)                                  # an exact full-payload retry is idempotent
    assert err is None and again["status"] == "done" and again["updated_at"] == first["updated_at"]
    _, err = call(c, code, "hive_goal_result", {**good, "data": {"verdict": "fail"}})
    assert err is not None and c.hive.goals.get(g["id"])["result_data"] == json.dumps({"proposal": {"verdict": "pass"}})


def test_unbound_goal_refuses_a_digest_and_plain_results_still_work(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    g = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "plain"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": g["id"]})
    _, err = call(c, code, "hive_goal_result", {"goal_id": g["id"], "status": "done", "result": "x", "binding_digest": "sha256:" + HEX})
    assert err["code"] == "binding_mismatch"
    out, err = call(c, code, "hive_goal_result", {"goal_id": g["id"], "status": "done", "result": "fine", "data": {"anything": 1}})
    assert err is None and out["status"] == "done"


# ---- leases ---------------------------------------------------------------------------------------------------

def test_heartbeat_renews_only_live_held_work_and_never_past_the_deadline(c):
    sw = swarm(c, "Team")
    code, other = member(c, sw, "Claude"), member(c, sw, "Other")
    live = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "live", "deadline_minutes": 1}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": live["id"]})
    beat, err = call(c, code, "hive_goal_heartbeat", {"goal_id": live["id"]})
    assert err is None and beat["status"] == "claimed" and beat["lease_until"] <= live["deadline_at"]      # lease capped at the hard deadline
    _, err = call(c, other, "hive_goal_heartbeat", {"goal_id": live["id"]})
    assert err["code"] == "not_claimed"
    c.hive.db.update("goals", live["id"], {"deadline_at": "2000-01-01T00:00:00.000Z"})
    _, err = call(c, code, "hive_goal_heartbeat", {"goal_id": live["id"]})
    assert err["code"] == "deadline_passed"                                                                 # expired work is not reopened
    assert c.hive.goals.get(live["id"])["status"] == "claimed"
    plain = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "plain"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": plain["id"]})
    call(c, code, "hive_goal_result", {"goal_id": plain["id"], "status": "done", "result": "ok"})
    _, err = call(c, code, "hive_goal_heartbeat", {"goal_id": plain["id"]})
    assert err["code"] == "not_claimed" and c.hive.goals.get(plain["id"])["status"] == "done"             # done stays done
    gone = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "gone"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": gone["id"]})
    c.hive.db.update("goals", gone["id"], {"status": "cancelled"})
    _, err = call(c, code, "hive_goal_heartbeat", {"goal_id": gone["id"]})
    assert err["code"] == "not_claimed" and c.hive.goals.get(gone["id"])["status"] == "cancelled"        # cancelled stays cancelled
    ack, err = call(c, code, "hive_goal_cancel_ack", {"goal_id": gone["id"]})
    assert err is None and ack["cancel_ack_by"] == agent_row(c, code)["id"]
    _, err = call(c, other, "hive_goal_cancel_ack", {"goal_id": gone["id"]})
    assert err["http_status"] == 403
    _, err = call(c, code, "hive_goal_result", {"goal_id": gone["id"], "status": "done", "result": "late"})
    assert err["code"] == "goal_cancelled"


# ---- exact reads ---------------------------------------------------------------------------------------------

def make_exhibit(c, owner_code, reader_name, atoms=3):
    owner = agent_row(c, owner_code)
    return c.portal.call(c.hive.shares.exhibit, owner, "Findings", reader_name, 30, "the body", [f"(--> item{i} thing)" for i in range(atoms)], None, None)


def test_exhibit_read_pages_are_bound_to_the_digest_and_rechecked(c):
    sw = swarm(c, "Team")
    owner, reader, stranger = member(c, sw, "Owner"), member(c, sw, "Reader"), member(c, sw, "Stranger")
    ex = make_exhibit(c, owner, "Reader", atoms=450)
    share = c.hive.db.one("SELECT id FROM shares WHERE exhibit_id = ?", (ex["exhibit_id"],))["id"]
    digest = ex["digest"]
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share})
    assert err["code"] == "bad_request"                                                   # expected_digest is required
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": "sha256:" + HEX})
    assert err["code"] == "digest_mismatch" and err["http_status"] == 409 and "the body" not in json.dumps(err) and digest not in json.dumps(err)
    _, err = call(c, stranger, "hive_exhibit_read", {"share_id": share, "expected_digest": "sha256:" + HEX})
    assert err["http_status"] == 403 and err["code"] == "forbidden"                       # identity before any digest detail
    seen, cursor = [], None
    while True:
        page, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": digest, **({"cursor": cursor} if cursor else {})})
        assert err is None and page["digest"] == digest
        assert (page["body"] == "the body") == (not seen)                                 # the body comes once, on the first page
        seen += page["atoms"]
        cursor = page["next_cursor"]
        assert (cursor is None) == page["end"]
        if len(seen) == 200:
            first_cursor = cursor
            c.hive.db.update("shares", share, {"status": "revoked"})                      # revoke after page one: the next page is refused
            _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": digest, "cursor": cursor})
            assert err["code"] == "share_closed" and err["http_status"] == 410
            c.hive.db.update("shares", share, {"status": "active"})
        if page["end"]:
            break
    assert len(seen) == 450 and len(set(seen)) == 450
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": digest, "cursor": first_cursor[:-3] + "abc"})
    assert err["code"] == "bad_cursor"
    _, err = call(c, stranger, "hive_exhibit_read", {"share_id": share, "expected_digest": digest, "cursor": first_cursor})
    assert err["http_status"] == 403
    mismatch = c.hive.db.one("SELECT digest FROM exhibits WHERE id = ?", (ex["exhibit_id"],))["digest"]
    c.hive.db.update("exhibits", ex["exhibit_id"], {"digest": "sha256:" + "b" * 64})      # the exhibit changed under an open cursor
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": mismatch, "cursor": first_cursor})
    assert err["code"] == "digest_mismatch"
    c.hive.db.update("exhibits", ex["exhibit_id"], {"digest": mismatch})
    c.hive.db.update("shares", share, {"expires_at": "2000-01-01T00:00:00.000Z"})
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": digest})
    assert err["code"] == "share_closed"


def test_cursors_expire_after_ten_minutes(c, monkeypatch):
    sw = swarm(c, "Team")
    owner, reader = member(c, sw, "Owner"), member(c, sw, "Reader")
    ex = make_exhibit(c, owner, "Reader", atoms=450)
    share = c.hive.db.one("SELECT id FROM shares WHERE exhibit_id = ?", (ex["exhibit_id"],))["id"]
    page, _ = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": ex["digest"]})
    real = mcp.time.time
    monkeypatch.setattr(mcp.time, "time", lambda: real() + 601)
    _, err = call(c, reader, "hive_exhibit_read", {"share_id": share, "expected_digest": ex["digest"], "cursor": page["next_cursor"]})
    assert err["code"] == "cursor_expired" and err["http_status"] == 410


def test_artifact_reads_are_exact_retained_and_identity_first(c):
    owner_sw, other_sw = swarm(c, "Owners"), swarm(c, "Others")
    owner, other = member(c, owner_sw, "Owner"), member(c, other_sw, "Other")
    collab, me = c.hive.collab, agent_row(c, owner)
    art = collab.create_artifact(me, {"kind": "plan", "title": "Plan"})
    r1 = collab.add_revision(me, art["id"], {"body": json.dumps({"steps": {"a": 1}}), "parent": None})
    r2 = collab.add_revision(me, art["id"], {"body": json.dumps({"steps": {"a": 2}}), "parent": 1})
    for tool in ("hive_artifact_read", "hive_revision_read"):                              # the alias is the same tool
        got, err = call(c, owner, tool, {"artifact_id": art["id"], "revision": 1, "expected_digest": r1["digest"]})
        assert err is None and got["revision"] == 1 and got["digest"] == r1["digest"] and json.loads(got["body"]) == {"steps": {"a": 1}}
        assert got["assets"] == []
    _, err = call(c, owner, "hive_artifact_read", {"artifact_id": art["id"], "revision": 1, "expected_digest": r2["digest"]})
    assert (err["code"], err["http_status"]) == ("digest_mismatch", 409) and r1["digest"] not in json.dumps(err) and "steps" not in json.dumps(err)
    _, err = call(c, owner, "hive_artifact_read", {"artifact_id": art["id"], "revision": 1})
    assert err["code"] == "bad_request"
    _, err = call(c, other, "hive_artifact_read", {"artifact_id": art["id"], "revision": 1, "expected_digest": "sha256:" + HEX})
    assert err["http_status"] == 403                                                      # no access: refused before any mismatch is mentioned
    # a live typed request on exactly revision 1 lets the other swarm read exactly that revision, and no newer one
    goal = c.post(f"/api/swarms/{owner_sw['id']}/goals", json={"title": "ask"}, headers=c.admin).json()
    call(c, owner, "hive_goal_claim", {"goal_id": goal["id"]})
    c.hive.collab.set_services(other_sw["id"], ["plan-check"], "test")
    req, err = call(c, owner, "hive_request", {"kind": "plan-check", "to": {"kind": "swarm", "id": other_sw["id"]}, "from_goal": goal["id"], "title": "check",
                                               "subject": {"artifact_id": art["id"], "revision": 1, "digest": r1["digest"]}, "deadline_minutes": 30,
                                               "idempotency_key": "k1"})
    assert err is None
    got, err = call(c, other, "hive_artifact_read", {"artifact_id": art["id"], "revision": 1, "expected_digest": r1["digest"]})
    assert err is None and got["digest"] == r1["digest"]                                  # exact retained revision, though revision 2 exists
    _, err = call(c, other, "hive_artifact_read", {"artifact_id": art["id"], "revision": 2, "expected_digest": r2["digest"]})
    assert err["http_status"] == 403
    c.hive.db.update("goals", req["goal_id"], {"status": "done"})
    _, err = call(c, other, "hive_artifact_read", {"artifact_id": art["id"], "revision": 1, "expected_digest": r1["digest"]})
    assert err["http_status"] == 403                                                      # access closes with the receiving goal


# ---- typed request ---------------------------------------------------------------------------------------------

def test_request_is_idempotent_by_key_and_payload(c):
    a_sw, b_sw = swarm(c, "Asking"), swarm(c, "Serving")
    asker = member(c, a_sw, "Asker")
    c.hive.collab.set_services(b_sw["id"], ["plan-check"], "test")
    goal = c.post(f"/api/swarms/{a_sw['id']}/goals", json={"title": "mine"}, headers=c.admin).json()
    call(c, asker, "hive_goal_claim", {"goal_id": goal["id"]})
    base = {"kind": "plan-check", "to": {"kind": "swarm", "id": b_sw["id"]}, "from_goal": goal["id"], "title": "check my plan",
            "deadline_minutes": 30, "budget_usd": 0, "idempotency_key": "once"}
    first, err = call(c, asker, "hive_request", base)
    assert err is None and set(first) == {"request_id", "goal_id"}
    assert c.hive.goals.get(first["goal_id"])["swarm_id"] == b_sw["id"]
    count = lambda: (c.hive.db.one("SELECT COUNT(*) n FROM requests")["n"], c.hive.db.one("SELECT COUNT(*) n FROM goals WHERE swarm_id = ?", (b_sw["id"],))["n"])
    before = count()
    again, err = call(c, asker, "hive_request", base)
    assert err is None and again == first and count() == before                           # a retry creates nothing
    # a crash after the request row but before the idempotency row: the request row itself answers the retry
    c.hive.db.execute("DELETE FROM mcp_idempotency WHERE idem_key = 'once'")
    again, err = call(c, asker, "hive_request", base)
    assert err is None and again == first and count() == before
    c.hive.db.execute("DELETE FROM mcp_idempotency WHERE idem_key = 'once'")
    _, err = call(c, asker, "hive_request", {**base, "title": "changed after the crash"})
    assert (err["code"], err["http_status"]) == ("idempotency_conflict", 409) and count() == before
    _, err = call(c, asker, "hive_request", {**base, "title": "a different ask"})
    assert (err["code"], err["http_status"]) == ("idempotency_conflict", 409) and count() == before
    for missing in ("idempotency_key", "from_goal", "title", "deadline_minutes", "to"):
        _, err = call(c, asker, "hive_request", {k: v for k, v in base.items() if k != missing})
        assert err["code"] == "bad_request" and count() == before
    by_service, err = call(c, asker, "hive_request", {**base, "to": {"kind": "service", "name": "plan-check"}, "idempotency_key": "svc", "contract": {"id": "plan-check", "version": "1"}})
    assert err is None and c.hive.goals.get(by_service["goal_id"])["swarm_id"] == b_sw["id"]
    stored = json.loads(c.hive.db.one("SELECT constraints FROM requests WHERE id = ?", (by_service["request_id"],))["constraints"])
    assert stored["contract"] == {"id": "plan-check", "version": "1"}
    _, err = call(c, asker, "hive_request", {**base, "to": {"kind": "service", "name": "nobody-offers-this"}, "idempotency_key": "x"})
    assert err["code"] == "not_offered"
    other = c.post(f"/api/swarms/{a_sw['id']}/goals", json={"title": "not held"}, headers=c.admin).json()
    _, err = call(c, asker, "hive_request", {**base, "from_goal": other["id"], "idempotency_key": "y"})
    assert err["code"] == "goal_not_held"
    for hive_code in ("request_budget", "connection_budget"):                                # budget refusals carry the contract name (L0)
        wire = mcp.Harnesses._fail(1, c.hive.error(402, hive_code, "no budget left"))["error"]["data"]
        assert (wire["code"], wire["http_status"]) == ("spend_limit", 402)


# ---- inventory and policy --------------------------------------------------------------------------------------

def test_capabilities_without_a_boot_receipt_and_policy_parity(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    me = agent_row(c, code)
    caps, err = call(c, code, "hive_capabilities")
    assert err is None and caps["mind_id"] == me["id"] and caps["inventory_revision"] is None and caps["loaded_at"] is None
    assert caps["availability"] == "no-boot-receipt" and caps["snapshot_at"] and caps["skills"] == []   # no evidence, no claim
    decided = {n: d["decision"] for t in caps["mcp_tools"] for n, d in t["policy"].items()}           # discovery, kept apart
    ids = set(decided)
    assert {"hive-goal-done", "hive-goal-fail", "hive-goal-get", "hive-goal-heartbeat", "hive-goal-cancel-ack", "hive-shared", "hive-revision-read",
            "hive-request", "hive-capabilities", "hive-query"} <= ids
    # the decision shown is the decision the native gate gives, and enforcement over MCP agrees with it
    c.hive.policy.add_rule(f"agent:{me['id']}", "hive-request", "deny", "test")
    c.hive.policy.add_rule(f"agent:{me['id']}", "hive-goal-heartbeat", "ask", "test")
    caps, _ = call(c, code, "hive_capabilities")
    shown = {n: d["decision"] for t in caps["mcp_tools"] for n, d in t["policy"].items()}
    assert shown["hive-request"] == "deny" and shown["hive-goal-heartbeat"] == "ask" and shown["hive-goal-get"] == "allow"
    for skill, mode in shown.items():
        assert c.hive.policy.decide(me, skill)[0] == mode
    g = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "held"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": g["id"]})
    _, err = call(c, code, "hive_request", {"kind": "plan-check", "to": {"kind": "swarm", "id": "sw_x"}, "from_goal": g["id"], "title": "t",
                                            "deadline_minutes": 5, "idempotency_key": "k"})
    assert (err["code"], err["http_status"]) == ("policy_denied", 403)
    _, err = call(c, code, "hive_goal_heartbeat", {"goal_id": g["id"]})
    assert err["code"] == "approval_required" and err["details"]["approval_id"]            # asks need a person, as natively
    pending = c.hive.policy.approvals("pending")
    assert [a["skill"] for a in pending] == ["hive-goal-heartbeat"]
    c.hive.policy.add_rule(f"agent:{me['id']}", "hive-goal-get", "deny", "test")
    _, err = call(c, code, "hive_goal_get", {"goal_id": g["id"]})
    assert err["code"] == "policy_denied"
    c.hive.policy.add_rule(f"agent:{me['id']}", "hive-goal-fail", "deny", "test")
    _, err = call(c, code, "hive_goal_result", {"goal_id": g["id"], "status": "failed", "result": "no"})
    assert err["code"] == "policy_denied"
    done, err = call(c, code, "hive_goal_result", {"goal_id": g["id"], "status": "done", "result": "yes"})     # a different skill: still allowed
    assert err is None and done["status"] == "done"


# ---- evidence query (L1 host + OmegaAtom's real validator and projection) ---------------------------------------

def rec(owner, n, scope, statement, *, subject=None, truth=0.9, unknown=False, status="observed", premises=None, stamp=None, rule=None):
    r = {"id": ["ev", owner, n], "statement": statement, "source": {"owner": owner, "subject": subject or f"s{n}", "revision": 1, "digest": HEX},
         "status": status, "scope": scope, "stamp": stamp or [["ev", owner, n]], "unknown": unknown}
    if not unknown:
        r["truth"] = ["stv", truth, 0.5 if not premises else 0.45]
    if premises:
        r["premises"], r["rule"] = premises, rule or ["deduce", "1"]
    return r


def snapshot(scope, records, revision=1):
    return {"version": "0.1", "owner": "hive", "scope": scope, "revision": revision, "records": records}


@needs_atom
def test_evidence_query_projects_closed_pages_with_withdrawal_controls(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    me, scope = agent_row(c, code), sw["id"]
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(--> $a $b)"})
    assert err["code"] == "evidence_store_absent" and err["http_status"] == 501
    base = [rec("m1", 1, scope, ["-->", "sky", "blue"], subject="obs1"), rec("m1", 2, scope, ["gloomy", "sky"], subject="obs2"),
            rec("m1", 3, scope, ["unknown-thing", "x"], unknown=True, subject="obs3"),
            rec("m1", 4, scope, ["Retracted", ["ev", "m1", 1], "bad sensor", "person1", 5], subject="ret1", truth=1.0)]
    derived = rec("m1", 5, scope, ["conclusion", "sky"], status="inferred", premises=[["ev", "m1", 1]], stamp=[["ev", "m1", 1]])
    state = {"snap": snapshot(scope, base + [derived], revision=7)}
    c.hive.harnesses.evidence_source = lambda scope_id: copy.deepcopy(state["snap"]) if scope_id == scope else None
    out, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)"})
    assert err is None and out["closure_complete"] is True and out["result_complete"] is True and out["end"] is True and out["next_cursor"] is None
    (page,) = out["snapshots"]
    ids = {tuple(r["id"]) for r in page["records"]}
    assert ids == {("ev", "m1", 1), ("ev", "m1", 4), ("ev", "m1", 5)}                  # the match, its premise AND the control that withdraws the premise
    assert page["scope"] == scope and page["revision"] == 7
    unknown, err = call(c, code, "hive_evidence_query", {"pattern": "(unknown-thing $x)"})
    (usnap,) = unknown["snapshots"]
    assert usnap["records"][0]["unknown"] is True and "truth" not in usnap["records"][0]   # unknown stays unknown, never c = 0
    none, err = call(c, code, "hive_evidence_query", {"pattern": "(nothing-matches $x)"})
    assert err is None and none["snapshots"][0]["records"] == [] and none["end"]
    # scopes: own scope is always included; others need an S2 grant, which does not exist yet
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)", "scopes": [{"scope_id": "sw_other"}]})
    assert err["http_status"] == 403
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)", "scopes": [{"grant_id": "gr_1"}]})
    assert err["http_status"] == 404
    for bad in ({"scope_id": "a", "grant_id": "b"}, {}, {"scope_id": 5}, {"scope_id": scope, "expected_revision": "x"}, "scope"):
        _, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)", "scopes": [bad]})
        assert err["code"] == "bad_request"
    ok, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)", "scopes": [{"scope_id": scope, "expected_revision": 7}]})
    assert err is None and len(ok["snapshots"]) == 1
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)", "scopes": [{"scope_id": scope, "expected_revision": 6}]})
    assert err["code"] == "stale_revision"
    _, err = call(c, code, "hive_evidence_query", {"pattern": "((", })
    assert err["code"] == "bad_pattern"
    before = json.dumps(state["snap"], sort_keys=True)
    call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)"})
    assert json.dumps(state["snap"], sort_keys=True) == before                              # reads add no evidence
    # policy: a denied hive-query refuses the evidence query too
    c.hive.policy.add_rule(f"agent:{me['id']}", "hive-query", "deny", "test")
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(conclusion $x)"})
    assert err["code"] == "policy_denied"


@needs_atom
def test_evidence_pages_split_between_closure_groups_and_stay_bound(c):
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    scope = sw["id"]
    records = [rec("m1", n, scope, ["-->", f"thing{n}", "ok"], subject=f"o{n}") for n in range(1, 451)]
    state = {"snap": snapshot(scope, records, revision=3)}
    c.hive.harnesses.evidence_source = lambda scope_id: copy.deepcopy(state["snap"])
    seen, cursor, pages = [], None, 0
    while True:
        out, err = call(c, code, "hive_evidence_query", {"pattern": "(--> $a ok)", **({"cursor": cursor} if cursor else {})})
        assert err is None and out["closure_complete"] is True and len(out["snapshots"]) == 1
        page = out["snapshots"][0]
        assert len(page["records"]) <= 200
        seen += [tuple(r["id"]) for r in page["records"]]
        pages += 1
        assert out["result_complete"] == out["end"] == (out["next_cursor"] is None)
        if pages == 1:
            first = out["next_cursor"]
            assert out["result_complete"] is False                                           # a partial page is never presented as complete
        if out["end"]:
            break
        cursor = out["next_cursor"]
    assert pages == 3 and len(seen) == 450 and len(set(seen)) == 450
    state["snap"] = snapshot(scope, records, revision=4)                                    # the scope moved on: the old cursor is refused
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(--> $a ok)", "cursor": first})
    assert err["code"] == "stale_revision"
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(--> $a bad)", "cursor": first})   # a cursor belongs to one query
    assert err["code"] == "stale_revision"
    _, err = call(c, code, "hive_evidence_query", {"pattern": "(--> $a ok)", "cursor": first[:-2] + "00"})
    assert err["code"] == "bad_cursor"
    other = member(c, sw, "Other")
    _, err = call(c, other, "hive_evidence_query", {"pattern": "(--> $a ok)", "cursor": first})
    assert err["code"] == "bad_cursor"                                                       # not another member's cursor


# ---- conformance with HiveConnect's own client (L1: their DraftReadClient against this disposable host) ---------

HC = pathlib.Path(os.environ.get("HIVECONNECT_PATH", str(SIBLINGS)))


@pytest.mark.skipif(not (HC / "hiveconnect" / "draft_client.py").exists(),
                    reason="needs sibling repo hiveconnect (HiveConnect's client, not in this repository; set HIVECONNECT_PATH)")
@needs_atom
def test_hiveconnect_draft_read_client_runs_against_this_host(c):
    sys.path.insert(0, str(HC))
    try:
        from hiveconnect.draft_client import DraftReadClient, HiveRemoteError
        import omegaatom.envelope as envelope
    finally:
        sys.path.remove(str(HC))
    sw = swarm(c, "Team")
    code = member(c, sw, "Claude")
    me = agent_row(c, code)

    def transport(wire):
        return c.post("/omegahive/mcp", content=wire, headers={"Authorization": f"Bearer {code}", "Content-Type": "application/json"}).content

    client = DraftReadClient(transport, expected_server_version="0.2.0", expected_mind_id=me["id"], atom_validator=envelope.validate)
    # Only the query tool differs from their provisional schema: ours adds the opaque `cursor` argument paging needs.
    ours = {t["name"]: t["inputSchema"] for t in rpc(c, code, "tools/list").json()["result"]["tools"]}
    mine = copy.deepcopy(ours["hive_evidence_query"])
    assert mine["properties"].pop("cursor") == {"type": "string"} and mine == client.schemas["hive_evidence_query"]
    client.schemas["hive_evidence_query"] = ours["hive_evidence_query"]
    for name in set(client.schemas) - {"hive_evidence_query"}:
        assert ours[name] == client.schemas[name], name
    assert client.initialize()["schema"] == "s3-r1"
    assert client.call("hive_whoami", {})["id"] == me["id"]
    caps = client.call("hive_capabilities", {})
    assert caps["availability"] == "no-boot-receipt" and caps["inventory_revision"] is None
    g = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "held"}, headers=c.admin).json()
    call(c, code, "hive_goal_claim", {"goal_id": g["id"]})
    assert client.call("hive_goal_get", {"goal_id": g["id"]})["id"] == g["id"]
    with pytest.raises(HiveRemoteError) as caught:
        client.call("hive_artifact_read", {"artifact_id": "ar_none", "revision": 1, "expected_digest": "sha256:" + HEX})
    assert caught.value.code == "unclassified_remote_error"                                  # not_found is not in their closed list: never invented
    scope = sw["id"]
    c.hive.harnesses.evidence_source = lambda s: snapshot(scope, [rec("m1", 1, scope, ["-->", "a", "b"])])
    page = client.call("hive_evidence_query", {"pattern": "(--> $x $y)"})
    checked = client.validate_query_page(page, page["snapshots"])
    assert checked["page"]["end"] is True and len(checked["snapshots"]) == 1


def test_published_schema_document_matches_the_tools_exactly():
    """hive/MCP_S3.md is the build's published copy of every tool schema (L0 drift guard)."""
    text = (pathlib.Path(mcp.__file__).resolve().parents[1] / "MCP_S3.md").read_text()
    for tool in mcp.TOOLS + [dict(name=k, **v) for k, v in mcp.GATED.items()]:
        assert f"### `{tool['name']}`" in text and json.dumps(tool["inputSchema"], indent=2) in text, tool["name"]
    assert '"x-hive-schema"] == "s3-r1"' in text and "0.2.0" in text


# ---- Kimi 2026-10-04 bridge findings ------------------------------------------------------------------------

def _asker(c):
    a_sw, b_sw = swarm(c, "Asking"), swarm(c, "Serving")
    asker = member(c, a_sw, "Asker")
    c.hive.collab.set_services(b_sw["id"], ["plan-check"], "test")
    goal = c.post(f"/api/swarms/{a_sw['id']}/goals", json={"title": "mine"}, headers=c.admin).json()
    call(c, asker, "hive_goal_claim", {"goal_id": goal["id"]})
    base = {"kind": "plan-check", "to": {"kind": "swarm", "id": b_sw["id"]}, "from_goal": goal["id"], "title": "check",
            "deadline_minutes": 30, "budget_usd": 0, "idempotency_key": "k1"}
    return asker, b_sw, base


def test_a_recorded_key_does_not_answer_once_policy_refuses(c):
    asker, _, base = _asker(c)
    first, err = call(c, asker, "hive_request", base)
    assert err is None
    me = c.hive.authenticate_agent(asker["token"]) if isinstance(asker, dict) and "token" in asker else None
    agent_id = me["id"] if me else c.hive.db.one("SELECT agent_id FROM mcp_idempotency WHERE idem_key = 'k1'")["agent_id"]
    c.hive.policy.add_rule(f"agent:{agent_id}", "hive-request", "deny", "test")
    _, err = call(c, asker, "hive_request", base)
    assert (err["code"], err["http_status"]) == ("policy_denied", 403)


def test_a_failure_inside_the_request_writes_leaves_nothing_behind(c, monkeypatch):
    asker, b_sw, base = _asker(c)
    count = lambda: (c.hive.db.one("SELECT COUNT(*) n FROM requests")["n"],
                     c.hive.db.one("SELECT COUNT(*) n FROM goals WHERE swarm_id = ?", (b_sw["id"],))["n"],
                     c.hive.db.one("SELECT COUNT(*) n FROM mcp_idempotency")["n"])
    before = count()
    real = c.hive.db.insert
    def failing(table, values):
        if table == "mcp_idempotency":
            raise RuntimeError("crash between request and record")
        return real(table, values)
    monkeypatch.setattr(c.hive.db, "insert", failing)
    _, err = call(c, asker, "hive_request", base)
    assert err is not None and count() == before            # request row and receiving goal rolled back with it
    monkeypatch.setattr(c.hive.db, "insert", real)
    first, err = call(c, asker, "hive_request", base)
    assert err is None and count() == (before[0] + 1, before[1] + 1, before[2] + 1)
    again, _ = call(c, asker, "hive_request", base)
    assert again == first and count() == (before[0] + 1, before[1] + 1, before[2] + 1)


def test_the_inbox_cursor_is_an_exact_non_negative_integer(c):
    sw = swarm(c, "Team")
    me = member(c, sw, "Me")
    for bad in (-1, 1.9, "3"):
        _, err = call(c, me, "hive_inbox", {"after": bad})
        assert err is not None and err["code"] in ("bad_request", "invalid_params"), bad
    out, err = call(c, me, "hive_inbox", {"after": 0})
    assert err is None and out["messages"] == []


def test_an_approval_to_close_a_goal_is_bound_to_the_exact_result(c):
    sw = swarm(c, "Team")
    me = member(c, sw, "Me")
    g = c.post(f"/api/swarms/{sw['id']}/goals", json={"title": "held"}, headers=c.admin).json()
    call(c, me, "hive_goal_claim", {"goal_id": g["id"]})
    agent_id = c.hive.goals.get(g["id"])["claimed_by"]
    c.hive.policy.add_rule(f"agent:{agent_id}", "hive-goal-done", "ask", "test")
    _, err = call(c, me, "hive_goal_result", {"goal_id": g["id"], "status": "done", "result": "shipped it"})
    assert err["code"] == "approval_required"
    command = [a for a in c.hive.policy.approvals("pending") if a["skill"] == "hive-goal-done"][-1]["command"]
    assert "sha256:" in command and g["id"] in command and "shipped it" in command   # readable and exact


def test_a_null_optional_field_is_refused_and_does_not_brick_the_key(c):
    asker, _, base = _asker(c)
    first, err = call(c, asker, "hive_request", base)
    assert err is None
    _, err = call(c, asker, "hive_request", {**base, "subject": None})
    assert err["code"] == "bad_request"                    # the strict schema refuses a null before any digest
    again, err = call(c, asker, "hive_request", base)
    assert err is None and again == first                  # and the key is not bricked by the refused call
