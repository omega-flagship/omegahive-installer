"""Fixed member proof, admitted through this app's existing agent routes.

Tokens stay in a request-local context. No arbitrary destination or action is accepted.
The negative witness records a host exception; absence of forwarding is source-derived.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import hashlib
import hmac
import secrets
from pathlib import Path
import re
import time
from types import CodeType

import httpx

from .code import Code

REVIEWED_CODE_SHA256 = "0598833be8cdcc3f31d0069026f303b9d2c5a607b5cceeb21474826109c6ce11"
_PROOF_TIMEOUT_SECONDS = 20
KEYS = ("task_id", "repository_id", "workspace_id", "suggestion_id")
_SCOPE_KEY = "omegahive.private.code_mind_proof_gate"
_EPOCH_KEY = secrets.token_bytes(32)  # process-local fingerprint key, never returned or persisted
_CONTEXT = ContextVar("code_mind_proof_request", default=None)


class ProofError(Exception):
    status = 409
    code = "code_mind_proof_refused"
    message = "the member Code proof did not pass; no proof receipt was issued"


@dataclass(repr=False)
class _Context:
    app: object
    hive: object
    member_id: str
    swarm_id: str
    token_epoch: str = field(repr=False)
    credential: str | None = field(repr=False)
    eligible: bool = False
    owned_tasks: frozenset = field(default_factory=frozenset, repr=False)
    active: bool = True
    task: object = field(default_factory=asyncio.current_task, repr=False)


@dataclass
class GateWitness:
    path: str
    denied: bool = False


@contextmanager
def member_request(app, hive, agent, credential, *, eligible=False, owned_tasks=frozenset()):
    context = _Context(app, hive, agent["id"], agent["swarm_id"], agent["token_hash"], credential,
                       eligible=eligible, owned_tasks=frozenset(owned_tasks))
    marker = _CONTEXT.set(context)
    try:
        yield
    finally:
        # Invalidate the object too: an inherited context in a child task cannot retain a usable token.
        context.active = False
        context.credential = None
        _CONTEXT.reset(marker)


def note_host_denial(scope, exc):
    witness = scope.get(_SCOPE_KEY)
    if (type(witness) is GateWitness and scope.get("method") == "GET"
            and scope.get("path") == witness.path and not scope.get("query_string")
            and exc.status == 404 and exc.code == "not_relayed"):
        witness.denied = True


def validate_inputs(args):
    if (type(args) is not dict or set(args) != set(KEYS)
            or not all(type(args[k]) is str and re.fullmatch(r"[A-Za-z0-9_~-]{1,200}", args[k]) for k in KEYS)):
        # Do not reflect invalid arguments (including an accidentally supplied credential).
        raise ProofError()


def _member(context, agent, args):
    if (context is None or not context.active or not context.eligible or not context.credential
            or context.task is not asyncio.current_task() or context.member_id != agent["id"]
            or context.swarm_id != agent["swarm_id"] or context.token_epoch != agent["token_hash"]
            or context.app.state.hive is not context.hive):
        raise ProofError()
    live = context.hive.authenticate_agent(context.credential, surface="code-mind-proof")
    if (live is None or live["id"] != context.member_id or live["swarm_id"] != context.swarm_id
            or live["token_hash"] != context.token_epoch):
        raise ProofError()
    if args["task_id"] not in context.owned_tasks:
        raise ProofError()
    goal = context.hive.db.one("SELECT * FROM goals WHERE id = ?", (args["task_id"],))
    if (goal is None or goal["claimed_by"] != context.member_id or goal["status"] != "claimed"
            or goal["swarm_id"] != context.swarm_id):
        raise ProofError()


def _nested(code, name):
    return next(c for c in code.co_consts if isinstance(c, CodeType) and c.co_name == name)


def _epoch(context):
    hive = context.hive
    source = Path(__file__).with_name("code.py").read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if digest != REVIEWED_CODE_SHA256 or type(hive.code) is not Code:
        raise ProofError()
    loaded = hive.code.relay_agent.__func__.__code__
    reviewed = _nested(_nested(compile(source, loaded.co_filename, "exec", dont_inherit=True), "Code"), "relay_agent")
    if loaded != reviewed:
        raise ProofError()
    updates = hive.updates
    if not isinstance(updates.running_build, str) or not re.fullmatch(r"[0-9a-f]{40}", updates.running_build):
        raise ProofError()
    return (id(hive.code), updates.running_build, updates.started_at, digest, hive.code.intended_service_release)


def _claims(context, args, issued):
    if type(issued) is not dict or set(issued) != {"token", "claims"}:
        raise ProofError()
    claims = issued["claims"]
    if (type(claims) is not dict or type(issued["token"]) is not str or not issued["token"].startswith("hc1.")
            or claims.get("kind") != "agent" or claims.get("actor") != context.member_id
            or claims.get("swarm_id") != context.swarm_id or claims.get("task_id") != args["task_id"]
            or claims.get("repository_id") != args["repository_id"] or claims.get("actions") != ["read"]
            or claims.get("paths") != [] or claims.get("argv_prefixes") != [] or claims.get("grant_id") is not None
            or any(k in claims for k in ("delegated", "proposal_test", "copy_apply"))
            or claims.get("member_hash") != hashlib.sha256(context.credential.encode()).hexdigest()
            or type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
            or not 0 < claims["exp"] - claims["iat"] <= 60 or not claims["iat"] <= time.time() < claims["exp"]):
        raise ProofError()
    status = context.hive.services.capability_status(context.hive.services.by_name("omegacode"), claims["id"])
    if status.get("active") is not True or status.get("claims") != claims:
        raise ProofError()
    return claims


def _selected_workspace(response, repository, workspace):
    if response.status_code != 200:
        raise ProofError()
    rows = response.json()
    if (type(rows) is not list or sum(type(r) is dict and r.get("id") == workspace
            and r.get("repository_id") == repository and r.get("status") == "ready" for r in rows) != 1):
        raise ProofError()


async def _prove(context, agent, args):
    _member(context, agent, args)
    epoch = _epoch(context)
    epoch_fingerprint = hmac.new(_EPOCH_KEY, (context.member_id + ":" + context.token_epoch).encode(), hashlib.sha256).hexdigest()
    started = time.time()
    start_tick = time.monotonic()
    task_id, repo, workspace, suggestion = (args[k] for k in KEYS)
    positive = f"/api/agent/code/relay/v1/tasks/{task_id}/workspaces"
    negative = f"/api/agent/code/relay/v1/workspaces/{workspace}/suggestions/{suggestion}/candidate"
    witness = GateWitness(negative)

    async def current_app(scope, receive, send):
        # This closure and scope entry cannot be supplied through HTTP headers/tool arguments.
        if scope.get("path") == negative:
            scope[_SCOPE_KEY] = witness
        await context.app(scope, receive, send)

    transport = httpx.ASGITransport(app=current_app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://current-hive.invalid",
                                 follow_redirects=False, trust_env=False) as client:
        response = await client.post("/api/agent/code/capability",
            headers={"Authorization": "Bearer " + context.credential},
            json={"service": "omegacode", "task_id": task_id, "repository_id": repo,
                  "actions": ["read"], "ttl_seconds": 60})
        if response.status_code != 200:
            raise ProofError()
        issued = response.json()
        claims = _claims(context, args, issued)
        headers = {"Authorization": "Bearer " + issued["token"], "X-Hive-Token": context.credential}
        response = await client.get(positive, headers=headers)
        _selected_workspace(response, repo, workspace)
        _member(context, agent, args)
        response = await client.get(negative, headers=headers)
        body = response.json()
        if response.status_code != 404 or type(body) is not dict or type(body.get("error")) is not dict or body["error"].get("code") != "not_relayed" or not witness.denied:
            raise ProofError()
        _member(context, agent, args)
        # The local negative never enters Code. Re-read with this SAME capability
        # so Code-local grant revocation/read scope is checked after that leg too.
        response = await client.get(positive, headers=headers)
        _selected_workspace(response, repo, workspace)
        _member(context, agent, args)
        _claims(context, args, issued)
        if _epoch(context) != epoch or time.monotonic() - start_tick > _PROOF_TIMEOUT_SECONDS:
            raise ProofError()
    return {"schema": "omegahive-code-mind-proof/v1", "transport": "current-app-ASGI",
            "member_id": context.member_id, "swarm_id": context.swarm_id, "capability_id": claims["id"], **args,
            "credential_epoch_fingerprint": epoch_fingerprint, "credential_epoch_basis": "process_keyed_hmac",
            "started_at": started, "observed_at": time.time(), "host_build": epoch[1],
            "host_started_at": epoch[2], "host_code_sha256": epoch[3],
            "expected_code_release": epoch[4],
            "code_process_identity_basis": "requires_separate_rollout_observer",
            "positive_status": 200, "post_negative_scope_recheck_status": 200, "negative_status": 404, "negative_code": "not_relayed",
            "gate_witness": "host_not_relayed_exception", "no_forward_basis": "source_derived_early_deny",
            "observed_forward_count": None, "mind_proof": True, "mind_candidate_denial": True}


async def prove(agent, args):
    validate_inputs(args)
    context = _CONTEXT.get()
    try:
        if context is None or context.task is not asyncio.current_task():
            raise ProofError()
        _member(context, agent, args)
        async def bounded():
            # wait_for owns a new task on Python 3.10 as well as 3.11+. Only this
            # explicit child receives a fresh private context, invalidated on every exit.
            if not context.active or not context.credential:
                raise ProofError()
            with member_request(context.app, context.hive, agent, context.credential,
                                eligible=context.eligible, owned_tasks=context.owned_tasks):
                return await _prove(_CONTEXT.get(), agent, args)
        return await asyncio.wait_for(bounded(), timeout=_PROOF_TIMEOUT_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception:
        # No raw response, capability or exception text reaches MCP's logging/error renderer.
        raise ProofError() from None
