"""The host coding controller's own Code client: in process, as itself, never with a mind's credential.

The engine (code_controller_engine.py) acts with exactly the authority the request's lease gives its controller: every
capability is issued by the existing host paths (ProposalTests.issue, Minds.issue_copy_apply) for the lease's controller,
which re-check request, lease, grant, task and controller exactly as before. What differs is the credential and the
audit: the capability's member binding is the engine's own per-process secret (minted here, never stored, never read
from a mind's workspace), every capability records issued_by "host:code-controller-engine", and the Code calls go
through the host's own relay (Code.relay_agent) rather than a loopback HTTP call presenting a mind's token. Responses
are checked with the same validators the code-test-* skills use (modules/code/src/code_proposal.py).
"""
from __future__ import annotations

import json
import secrets
import urllib.parse

ENGINE = "host:code-controller-engine"


def new_credential():
    return "cce." + secrets.token_urlsafe(32)


class EngineCodeClient:
    def __init__(self, engine, run):
        self.engine, self.hive, self.run, self.cp = engine, engine.hive, run, engine.cp
        self.credential = engine.credential

    def close(self):
        return None

    def _ctl(self):
        return self.hive.agent(self.run["controller_id"])

    def _refused(self, code, phase, op=None, unknown=False):
        return self.cp.ProposalRefused(str(code), phase, op, unknown)

    # ---- the two host primitives ----------------------------------------------------------------------------------

    def _issue_test(self, body):
        """A proposal_test stage claim for the lease's controller, bound to the engine's credential. A refusal here is
        definite: the issuance runs in one host transaction, so nothing exists at Code or in the hive after it."""
        try:
            answer = self.hive.proposal_tests.issue(self._ctl(), self.credential,
                                                    {"service": "omegacode", "proposal_test": body}, by=ENGINE)
            p = self.cp._test_claims(answer["claims"], self.credential)
        except self.cp.ProposalRefused:
            raise
        except Exception as exc:
            raise self._refused(getattr(exc, "code", None) or "test_capability_refused", "capability") from None
        return answer["token"], answer["claims"], p

    async def relay(self, bearer, method, path, body=None, query=None):
        """(status, decoded JSON or None) from Code through the host relay. A relay failure the connection may have
        carried (502/504) is unknown; any other relay refusal happened before Code and is definite."""
        from .code import CodeError
        raw = b"" if body is None else self.cp.canonical(body)
        try:
            status, content, _ = await self.hive.code.relay_agent(self.credential, bearer, method, path,
                                                                  urllib.parse.urlencode(query or {}), raw)
        except CodeError as exc:
            raise self._refused(exc.code, "relay", None, exc.status in (502, 504)) from None
        try:
            value = self.cp.decode(content) if content else None
        except Exception:
            value = None
        return status, value

    @staticmethod
    def code_error(value):
        """Code's own refusal code from its error body ({"error": "<code>", "message": ...}), else None."""
        if isinstance(value, dict):
            error = value.get("error")
            if isinstance(error, dict):
                error = error.get("code")
            if isinstance(error, str) and error:
                return error
        return None

    # ---- the proposal test (code-test-prepare / code-test-run / code-test-result, as the engine) -------------------

    async def test_prepare(self, request_id, operation_id, proposal_id):
        from .code_test_intents import controller_lookup
        try:
            refs = await controller_lookup(self.hive.ask.intents, self._ctl(),
                                           {"request_id": request_id, "proposal_id": proposal_id})
        except Exception as exc:
            raise self._refused(getattr(exc, "code", None) or "test_context_unavailable", "context") from None
        body = {"operation_id": operation_id, "request_id": request_id, "proposal": refs["proposal"],
                "parent": {k: refs["parent"][k] for k in ("generation", "tree_digest")}}
        token, claims, p = self._issue_test(body)
        if p["stage"] == "run":                       # already bound (a replay of the same operation): no new preparation
            return {"status": "HOST_PREPARATION_ALREADY_BOUND", "test_id": p["test_id"], "fork": p["fork"],
                    "proposal": p["proposal"], "parent": p["parent"]}
        status, value = await self.relay(token, "POST", "/v1/proposal-tests", {})
        if status not in (200, 201):
            code = self.code_error(value)
            raise self._refused(code or "test_prepare_outcome_unknown", "prepare", operation_id, code is None)
        try:
            self.cp.require(set(value) == {"test_id", "ack", "launch_authority", "accepted_source"}
                            and value["test_id"] == p["test_id"] and value["launch_authority"] is False
                            and value["accepted_source"] is False, "test_prepare_receipt")
            ack = value["ack"]
            self.cp.require(type(ack) is dict and set(ack) == {"test_id", "fork_workspace_id", "test_tree_digest",
                                                               "preparation_digest", "bound_at"}
                            and ack["test_id"] == p["test_id"] and ack["fork_workspace_id"] != p["parent"]["workspace_id"],
                            "test_prepare_receipt")
        except (self.cp.ProposalRefused, TypeError, KeyError):
            raise self._refused("test_prepare_outcome_unknown", "prepare", operation_id, True) from None
        return {"status": "CONTROLLER_TEST_PREPARED", "test_id": p["test_id"],
                "fork": {"workspace_id": ack["fork_workspace_id"], "preparation_digest": ack["preparation_digest"]},
                "proposal": p["proposal"], "parent": p["parent"]}

    async def test_run(self, test_id, launch_key):
        token, claims, p = self._issue_test({"test_id": test_id, "stage": "run"})
        command = self.cp.simple_run_command(claims["argv_prefixes"], [])   # the operator's one declared test command
        status, value = await self.relay(token, "POST", f"/v1/proposal-tests/{test_id}/launches",
                                         {"launch_key": launch_key, **command})
        if status not in (200, 201, 202):
            code = self.code_error(value)
            raise self._refused(code or "test_launch_outcome_unknown", "launch", launch_key, code is None)
        try:
            self.cp.require(set(value) == {"record", "currency", "execution_currency", "tested", "accepted_source"}
                            and value["accepted_source"] is False, "test_launch_projection")
            result = self.cp._test_summary(value["record"], claims, launch_key, value["currency"],
                                           value["execution_currency"], value["tested"], command,
                                           redactions=(self.credential, token))
        except (self.cp.ProposalRefused, TypeError, KeyError, ValueError):
            raise self._refused("test_launch_outcome_unknown", "launch", launch_key, True) from None
        result["command"] = command
        return result

    async def test_result(self, test_id, launch_key):
        token, claims, p = self._issue_test({"test_id": test_id, "stage": "result"})
        status, value = await self.relay(token, "GET", f"/v1/proposal-tests/{test_id}", query={"launch_key": launch_key})
        if status != 200 or not isinstance(value, dict) or value.get("test_id") != test_id:
            raise self._refused(self.code_error(value) or "test_history_unavailable", "result")
        results = []
        for entry in value.get("results") or []:
            try:
                results.append(self.cp._test_summary(entry["result"], claims, entry["launch_key"], entry["currency"],
                                                     entry["execution_currency"], False,
                                                     redactions=(self.credential, token)))
            except (self.cp.ProposalRefused, TypeError, KeyError, ValueError):
                results.append({"status": "CONTROLLER_TEST_UNREADABLE", "launch_key": entry.get("launch_key")})
        return {"status": "CONTROLLER_TEST_HISTORY", "test_id": test_id, "results": results}

    # ---- the person's apply: the controller's copy_apply capability, as the engine ---------------------------------

    def issue_copy_apply(self, data):
        return self.hive.minds.issue_copy_apply(self._ctl(), self.credential, data, by=ENGINE)

    # ---- person-scope reads (the person's own read scope through the person relay; read-only) ----------------------

    async def person_read(self, path, query=None):
        """GET a Code route in the request person's read scope, as controller_lookup reads a retained proposal: the
        issuer and grant of the request's lease as Minds._request_lease returns it (the request's own, first-issued
        lease; a request has one). Read-only by construction: GET only, and the person relay mints a read capability
        for it. (status, decoded JSON or None)."""
        minds = self.hive.minds
        if self.run["member"]:                    # a plan member: the plan's task and the person's grant (its origin)
            o = json.loads(self.run["member"])["origin"]
            person, task, grant, repo = self.run["person"], o["task_id"], o["grant_id"], o["repository_id"]
        else:
            req = minds._request(self.run["request_id"])
            origin, lease = minds._request_origin(req), minds._request_lease(req["id"])
            person, task, grant, repo = lease["issued_by"], origin["task_id"], lease["grant_id"], origin["repository_id"]
        try:
            status, raw, _ = await self.hive.code.proxy(person, "GET", path, dict(query or {}), b"", task, grant, repo)
        except Exception as exc:
            return getattr(exc, "status", 503), {"error": getattr(exc, "code", type(exc).__name__)}
        try:
            return status, json.loads(raw)
        except (TypeError, ValueError):
            return status, None
