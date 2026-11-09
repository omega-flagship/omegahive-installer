"""L1 contract controls: exact selected HTTP handlers, real SQLite capability journal/HMAC,
actual Code.relay_agent, and a simulated service verifier. No app startup or socket.
These controls do not qualify the full app, native admission or real Code service.
"""
import ast
import asyncio
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import time
from types import SimpleNamespace

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import httpx
import pytest
from starlette.concurrency import run_in_threadpool

from hive.core import code as code_module
from hive.core import code_mind_proof as proof
from hive.core.code import Code, CodeError
from hive.core.db import Database, now
from hive.core.services import Services, ServiceError

ARGS = dict(task_id="task_a", repository_id="repo_a", workspace_id="ws_a", suggestion_id="suggestion_a")
MEMBER = "synthetic-member-never-return"
SECRET = "synthetic-capability-secret-never-return"


@pytest.fixture
def contract(tmp_path, monkeypatch):
    db = Database(tmp_path / "contract.sqlite", hive_schema=False)
    db.execute("CREATE TABLE agents (id TEXT PRIMARY KEY, swarm_id TEXT, token_hash TEXT, deleted INTEGER DEFAULT 0, last_active_at TEXT)")
    db.execute("CREATE TABLE goals (id TEXT PRIMARY KEY, swarm_id TEXT, claimed_by TEXT, status TEXT)")
    db.execute("CREATE TABLE approvals (id TEXT PRIMARY KEY, binding TEXT)")
    agent = dict(id="agent_a", swarm_id="sw_a", token_hash=hashlib.sha256(MEMBER.encode()).hexdigest())
    db.insert("agents", agent)
    db.insert("goals", dict(id="task_a", swarm_id="sw_a", claimed_by="agent_a", status="claimed"))
    hive = SimpleNamespace(db=db, updates=SimpleNamespace(running_build="a" * 40, started_at="synthetic-start"))
    hive.authenticate_agent = lambda token, surface=None: db.one("SELECT * FROM agents WHERE token_hash=? AND deleted=0", (hashlib.sha256(token.encode()).hexdigest(),)) if token else None
    hive.services = services = Services(hive)
    db.insert("services", dict(id="svc_code", name="omegacode", address="http://127.0.0.1:9999",
        token_hash="synthetic-service", capability_secret=SECRET, registered_at=now()))
    code = hive.code = Code.__new__(Code)
    code.hive = hive
    # Qualification of physical service pin/process identity belongs to Dot's observer, not this source control.
    code.require_intended_release = lambda: None
    app = FastAPI()
    app.state.hive = hive
    observed = SimpleNamespace(forwarded=[], issue_mode=None, positive_mode=None, after_positive=None, cancelled=False, retained_contexts=[], local_grants={}, local_revoke_after_negative=False)

    def bearer(value):
        return value[7:] if value and value.startswith("Bearer ") else ""

    def agent_from(request):
        live = hive.authenticate_agent(bearer(request.headers.get("authorization")))
        if live is None: raise CodeError(401, "unauthorized", "invalid member")
        return live

    async def body(request): return await request.json()

    async def handle(agent, message):
        try:
            result = await proof.prove(agent, message["params"]["arguments"])
            return {"jsonrpc": "2.0", "id": message["id"], "result": result}
        except proof.ProofError as exc:
            return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": exc.code, "message": exc.message}}

    harnesses = SimpleNamespace(member=hive.authenticate_agent, rate_ok=lambda _: True, handle=handle)
    def gate_witness(scope, exc):
        proof.note_host_denial(scope, exc)
        if observed.local_revoke_after_negative:
            for key in observed.local_grants: observed.local_grants[key] = False
    namespace = dict(app=app, hive=hive, services=services, code=code, harnesses=harnesses,
        Request=Request, Response=Response, JSONResponse=JSONResponse, CodeError=CodeError, HiveError=CodeError,
        run_in_threadpool=run_in_threadpool, _bearer=bearer, body=body, agent_from=agent_from,
        member_request=proof.member_request, note_host_denial=gate_witness, now=now, json=json)
    tree = ast.parse(Path(proof.__file__).with_name("app.py").read_bytes())
    factories = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    factory = factories["create_app"]
    if "_create_app" in factories:
        # Select the actual routed body only through the public owner wrapper.
        assert any(isinstance(n, ast.Return) and isinstance(n.value, ast.Call)
                   and isinstance(n.value.func, ast.Name) and n.value.func.id == "_create_app"
                   for n in ast.walk(factory))
        factory = factories["_create_app"]
    names = {"mcp_endpoint", "code_capability_agent", "code_relay_agent"}
    nodes = [n for n in factory.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
    assert len(nodes) == 3
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<selected-exact-http-handlers>", "exec", dont_inherit=True), namespace)

    async def error(request, exc):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)
    app.add_exception_handler(CodeError, error)
    app.add_exception_handler(ServiceError, error)

    original_issue = services.issue
    def issue(*args, **kwargs):
        issued = original_issue(*args, **kwargs)
        mode = observed.issue_mode
        if mode == "fake": issued["token"] = "hc1.fake.signature"
        if mode == "expired": db.update("capabilities", issued["claims"]["id"], {"expires_at": time.time() - 1})
        if mode == "revoked": db.update("capabilities", issued["claims"]["id"], {"revoked_at": now()})
        if mode == "escalated": issued["claims"]["actions"] = ["read", "edit"]
        return issued
    services.issue = issue

    async def simulated_proved_request(address, service_id, secret, method, path, raw, *, bearer, extra_headers):
        # A fake prefix cannot pass the positive leg: verify the real issue() HMAC and live journal/context.
        observed.forwarded.append(path)
        observed.retained_contexts.append(proof._CONTEXT.get())
        try:
            prefix, encoded, signature = bearer.split(".")
            assert prefix == "hc1" and hmac.compare_digest(signature,
                hmac.new(SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest())
            claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            assert services.capability_status(services.by_name("omegacode"), claims["id"])["active"]
            assert hive.authenticate_agent(extra_headers["X-Hive-Token"])["id"] == claims["actor"]
            assert claims["member_hash"] == hashlib.sha256(extra_headers["X-Hive-Token"].encode()).hexdigest()
            assert claims["repository_id"] == "repo_a" and claims["actions"] == ["read"]
            assert claims["task_id"] == "task_a" and claims["swarm_id"] == "sw_a"
        except (AssertionError, ValueError, KeyError, TypeError):
            return 403, {"content-type": "application/json"}, b'{"error":{"code":"bad_capability"}}'
        # Simulate Code's separate local grant row, which Hive capability_status does not inspect.
        observed.local_grants.setdefault(claims["id"], True)
        if not observed.local_grants[claims["id"]]:
            return 403, {"content-type": "application/json"}, b'{"error":{"code":"grant_revoked"}}'
        if path.endswith("/candidate"):
            return 404, {"content-type": "application/json"}, b'{"error":{"code":"not_relayed"}}'
        assert method == "GET" and path == "/v1/tasks/task_a/workspaces" and raw == b""
        if observed.positive_mode == "timeout":
            await asyncio.sleep(3600)
        if observed.positive_mode == "cancel":
            observed.cancelled = True
            raise asyncio.CancelledError()
        if observed.positive_mode == "failure": return 503, {}, b'{}'
        rows = [dict(id="ws_a", repository_id="repo_a", status="ready", private_body="PRIVATE-BODY-NEVER-RETURN")]
        if observed.positive_mode == "wrong_workspace": rows[0]["id"] = "other"
        if observed.positive_mode == "wrong_repository": rows[0]["repository_id"] = "other"
        if observed.after_positive: observed.after_positive()
        return 200, {"content-type": "application/json"}, json.dumps(rows).encode()
    monkeypatch.setattr(code_module, "proved_request", simulated_proved_request)
    yield SimpleNamespace(app=app, hive=hive, observed=observed, agent=agent, harnesses=harnesses)
    db._conn.close()


def call(contract, args=None, *, batch=False, token=MEMBER):
    message = dict(jsonrpc="2.0", id=1, method="tools/call",
                   params=dict(name="hive_code_mind_proof", arguments=ARGS if args is None else args))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=contract.app), base_url="http://contract.invalid") as client:
            response = await client.post("/mcp", headers={"Authorization": "Bearer " + token},
                                         json=[message,dict(message,id=2)] if batch else message)
            assert proof._CONTEXT.get() is None
            return response
    return asyncio.run(run())


def test_real_capability_positive_and_host_negative(contract, caplog):
    response = call(contract)
    result = response.json()["result"]
    assert result["mind_proof"] and result["mind_candidate_denial"]
    assert result["expected_code_release"] == code_module.INTENDED_SERVICE_RELEASE
    assert result["no_forward_basis"] == "source_derived_early_deny" and result["observed_forward_count"] is None
    assert contract.observed.forwarded == ["/v1/tasks/task_a/workspaces"] * 2
    assert result["post_negative_scope_recheck_status"] == 200
    assert contract.hive.db.one("SELECT count(*) AS n FROM capabilities")["n"] == 1
    rendered = response.text + caplog.text
    for private in [MEMBER, SECRET, "PRIVATE-BODY-NEVER-RETURN", "hc1.", "member_hash", "token_hash"]:
        assert private not in rendered


@pytest.mark.parametrize("mode", ["fake", "expired", "revoked", "escalated"])
def test_bad_capability_never_produces_receipt(contract, mode):
    contract.observed.issue_mode = mode
    assert "error" in call(contract).json()


@pytest.mark.parametrize("mode", ["failure", "wrong_workspace", "wrong_repository"])
def test_positive_must_validate_selected_workspace(contract, mode):
    contract.observed.positive_mode = mode
    assert "error" in call(contract).json()
    assert all(not p.endswith("/candidate") for p in contract.observed.forwarded)


def test_service_404_after_forward_is_not_host_denial(contract, monkeypatch):
    monkeypatch.setattr(Code, "AGENT_RELAY_PATH", re.compile(r"/v1/[A-Za-z0-9_./~-]*"))
    assert "error" in call(contract).json()
    assert contract.observed.forwarded[-1].endswith("/candidate")


@pytest.mark.parametrize("change", ["revoke_member", "change_task", "close_task", "change_epoch", "revoke_cap"])
def test_same_context_rechecked_after_positive(contract, change):
    db = contract.hive.db
    def mutate():
        if change == "revoke_member": db.update("agents", "agent_a", {"deleted": 1})
        elif change == "change_task": db.update("goals", "task_a", {"claimed_by": "other"})
        elif change == "close_task": db.update("goals", "task_a", {"status": "done"})
        elif change == "change_epoch": contract.hive.updates.started_at = "changed"
        elif change == "revoke_cap": db.execute("UPDATE capabilities SET revoked_at = ?", (now(),))
    contract.observed.after_positive = mutate
    assert "error" in call(contract).json()


def test_batch_does_not_reuse_cap_or_leak_context(contract):
    response = call(contract, batch=True)
    assert len(response.json()) == 2 and all("result" in r for r in response.json())
    assert response.json()[0]["result"]["capability_id"] != response.json()[1]["result"]["capability_id"]
    assert len(contract.observed.forwarded) == 4


def test_http_boundary_revoked_member_refuses(contract):
    contract.hive.db.update("agents", "agent_a", {"deleted": 1})
    assert call(contract).status_code == 401
    assert contract.observed.forwarded == []


def test_cancellation_clears_boundary_context(contract):
    contract.observed.positive_mode = "cancel"
    with pytest.raises(asyncio.CancelledError): call(contract)
    assert contract.observed.cancelled and proof._CONTEXT.get() is None
    assert all(not c.active and c.credential is None for c in contract.observed.retained_contexts)


def test_deadline_cancels_private_child_and_clears_context(contract, monkeypatch):
    monkeypatch.setattr(proof, "_PROOF_TIMEOUT_SECONDS", 0.01)
    contract.observed.positive_mode = "timeout"
    assert "error" in call(contract).json()
    assert contract.observed.forwarded == ["/v1/tasks/task_a/workspaces"]
    assert all(not c.active and c.credential is None for c in contract.observed.retained_contexts)


@pytest.mark.parametrize("change", ["missing", "unclaimed", "closed", "wrong_owner", "wrong_swarm"])
def test_invalid_task_never_mints_capability(contract, change):
    db = contract.hive.db
    if change == "missing": db.execute("DELETE FROM goals WHERE id = ?", ("task_a",))
    elif change == "unclaimed": db.update("goals", "task_a", {"status": "open", "claimed_by": None})
    elif change == "closed": db.update("goals", "task_a", {"status": "done"})
    elif change == "wrong_owner": db.update("goals", "task_a", {"claimed_by": "other"})
    elif change == "wrong_swarm": db.update("goals", "task_a", {"swarm_id": "other"})
    assert "error" in call(contract).json()
    assert db.one("SELECT count(*) AS n FROM capabilities")["n"] == 0
    assert contract.observed.forwarded == []


@pytest.mark.parametrize("extra", [dict(actions=["read", "edit"]), dict(paths=["other"]),
    dict(headers={"Authorization": "synthetic-extra-never-return"}), dict(url="https://example.invalid")])
def test_tool_cannot_expand_authority_or_return_extra_fields(contract, extra):
    response = call(contract, {**ARGS, **extra})
    assert "error" in response.json() and "synthetic-extra-never-return" not in response.text
    assert contract.hive.db.one("SELECT count(*) AS n FROM capabilities")["n"] == 0


def test_wrong_repository_cannot_pass_the_positive_service_admission(contract):
    assert "error" in call(contract, {**ARGS, "repository_id": "other"}).json()
    assert contract.observed.forwarded == ["/v1/tasks/task_a/workspaces"]


def test_parallel_http_requests_keep_member_and_capability_contexts_separate(contract):
    other_token = "synthetic-other-member"
    contract.hive.db.insert("agents", dict(id="agent_b", swarm_id="sw_b",
        token_hash=hashlib.sha256(other_token.encode()).hexdigest()))
    message = dict(jsonrpc="2.0", id=1, method="tools/call", params=dict(name="hive_code_mind_proof", arguments=ARGS))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=contract.app), base_url="http://contract.invalid") as client:
            async def send(token):
                return await client.post("/mcp", headers={"Authorization": "Bearer " + token}, json=message)
            valid, wrong = await asyncio.gather(send(MEMBER), send(other_token))
            assert "result" in valid.json() and "error" in wrong.json()
            assert proof._CONTEXT.get() is None
    asyncio.run(run())
    assert contract.hive.db.one("SELECT count(*) AS n FROM capabilities")["n"] == 1
    assert all(not c.active and c.credential is None for c in contract.observed.retained_contexts)


def test_newly_redeemed_identity_does_not_qualify_as_preexisting_context(contract):
    invite = "synthetic-invite-never-return"
    def redeem(token):
        assert token == invite
        contract.hive.db.insert("agents", dict(id="new_member", swarm_id="sw_a",
            token_hash=hashlib.sha256(token.encode()).hexdigest()))
        contract.hive.db.update("goals", "task_a", {"claimed_by": "new_member"})
        return contract.hive.authenticate_agent(token)
    contract.harnesses.member = redeem
    # This is deliberately a simulated ordinary-join effect, not a claim that real MCP joins have no effects.
    assert "error" in call(contract, token=invite).json()
    assert contract.hive.authenticate_agent(invite) is not None
    assert contract.hive.db.one("SELECT count(*) AS n FROM capabilities")["n"] == 0
    assert contract.observed.forwarded == []


def test_task_claimed_earlier_in_batch_is_not_an_arrival_owned_task(contract):
    contract.hive.db.update("goals", "task_a", {"status": "open", "claimed_by": None})
    original = contract.harnesses.handle
    async def handle(agent, message):
        if message["method"] == "synthetic-explicit-claim":
            contract.hive.db.update("goals", "task_a", {"status": "claimed", "claimed_by": "agent_a"})
            return {"jsonrpc": "2.0", "id": 1, "result": {"explicit_claim": True}}
        return await original(agent, message)
    contract.harnesses.handle = handle
    messages = [dict(jsonrpc="2.0", id=1, method="synthetic-explicit-claim"),
        dict(jsonrpc="2.0", id=2, method="tools/call", params=dict(name="hive_code_mind_proof", arguments=ARGS))]
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=contract.app), base_url="http://contract.invalid") as client:
            response = await client.post("/mcp", headers={"Authorization": "Bearer " + MEMBER}, json=messages)
            assert "result" in response.json()[0] and "error" in response.json()[1]
    asyncio.run(run())
    assert contract.hive.db.one("SELECT count(*) AS n FROM capabilities")["n"] == 0
    assert contract.observed.forwarded == []


def test_epoch_fingerprint_is_opaque_and_stable_only_within_process_epoch(contract):
    responses = call(contract, batch=True).json()
    first, second = (r["result"] for r in responses)
    assert first["credential_epoch_basis"] == "process_keyed_hmac"
    assert first["credential_epoch_fingerprint"] == second["credential_epoch_fingerprint"]
    assert re.fullmatch("[0-9a-f]{64}", first["credential_epoch_fingerprint"])
    assert first["credential_epoch_fingerprint"] != contract.agent["token_hash"]
    assert first["credential_epoch_fingerprint"] != hashlib.sha256(MEMBER.encode()).hexdigest()


def test_concurrent_claim_during_body_arrival_cannot_qualify(contract):
    db = contract.hive.db
    db.update("goals", "task_a", {"status": "open", "claimed_by": None})
    message = dict(jsonrpc="2.0", id=1, method="tools/call", params=dict(name="hive_code_mind_proof", arguments=ARGS))
    delivered = []
    async def request_body():
        # ASGI receives these bytes only when the real selected endpoint awaits request.body().
        db.update("goals", "task_a", {"status": "claimed", "claimed_by": "agent_a"})
        delivered.append(True)
        yield json.dumps(message).encode()
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=contract.app), base_url="http://contract.invalid") as client:
            response = await client.post("/mcp", headers={"Authorization": "Bearer " + MEMBER,
                                                        "Content-Type": "application/json"}, content=request_body())
            assert response.json()["error"]["code"] == "code_mind_proof_refused"
    asyncio.run(run())
    assert delivered == [True]
    assert db.one("SELECT claimed_by FROM goals WHERE id='task_a'")["claimed_by"] == "agent_a"
    assert db.one("SELECT count(*) AS n FROM capabilities")["n"] == 0
    assert contract.observed.forwarded == []


def test_code_local_grant_revoked_between_legs_cannot_pass_hive_only_checks(contract):
    contract.observed.local_revoke_after_negative = True
    response = call(contract)
    assert "error" in response.json()
    assert contract.observed.forwarded == ["/v1/tasks/task_a/workspaces"] * 2
    assert contract.observed.local_grants and not any(contract.observed.local_grants.values())
    for row in contract.hive.db.all("SELECT id FROM capabilities"):
        assert contract.hive.services.capability_status(contract.hive.services.by_name("omegacode"), row["id"])["active"]
    assert all(not c.active and c.credential is None for c in contract.observed.retained_contexts)
