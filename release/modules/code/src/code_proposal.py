"""A request child's v1 text proposals through the existing authenticated Hive relay.

The host issues the origin and scope. This client never creates a workspace, edits,
runs code, applies a proposal, or returns a bearer. Response checks restrict the
operation; the actual service signature, live-status and person gates authorize it.
"""
import contextlib
import hashlib
import json
import math
import re

import httpx

from pathlib import PurePosixPath
import os
import time

MAX_BODY = 4 * 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
REF = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")


class ProposalRefused(Exception):
    """Only bounded codes and operation custody, never HTTP bodies or credentials."""
    def __init__(self, code, phase, operation_id=None, outcome_unknown=False):
        super().__init__(code)
        self.code, self.phase = code, phase
        self.operation_id, self.outcome_unknown = operation_id, outcome_unknown


def require(condition, code="proposal_binding"):
    if condition is not True:
        raise ProposalRefused(code, "validation")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(items):
        result = {}
        for name, value in items:
            require(name not in result, "duplicate_field")
            result[name] = value
        return result
    def bad(_):
        raise ProposalRefused("nonfinite_json", "validation")
    return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs,
                      parse_constant=bad)


def ref(value, prefix=None):
    require(type(value) is str and REF.fullmatch(value) is not None, "reference")
    require(prefix is None or value.startswith(prefix), "reference")
    return value


# Exact v1 validator functions copied from pinned service309df; no service-package import.
MAX_BYTES = MAX_FILE
def path_ok(path):
    return isinstance(path, str) and bool(path) and not PurePosixPath(path).is_absolute() and all(
        p not in ('', '.', '..') for p in path.split('/')) and '\\' not in path and '\0' not in path


def boundary(data, offset):
    return type(offset) is int and 0 <= offset <= len(data) and (
        offset == len(data) or data[offset] & 0xC0 != 0x80)


def prepare(binding, files, trusted_ranges, proposals, groups=None):
    """Retain normalized immutable proposal data from bounded untrusted hunks."""
    if not proposals or len(proposals) > 1000:
        raise ValueError('hunk count')
    hunks = []
    for item in proposals:
        if set(item) != {'path', 'start_byte', 'end_byte', 'replacement', 'before_digest'}:
            raise ValueError('hunk fields')
        path = item['path']
        if not path_ok(path) or path not in files or path not in trusted_ranges:
            raise ValueError('path scope')
        data = files[path]
        if type(data) is not bytes or len(data) > MAX_BYTES:
            raise ValueError('saved source')
        data.decode('utf-8', errors='strict')
        start, end = item['start_byte'], item['end_byte']
        if not boundary(data, start) or not boundary(data, end) or start > end:
            raise ValueError('UTF-8 range')
        # Closed boundaries are explicitly granted by the trusted range issuer.
        if not any(type(a) is int and type(b) is int and 0 <= a <= start <= end <= b <= len(data)
                   for a, b in trusted_ranges[path]):
            raise ValueError('range scope')
        if item['before_digest'] != sha(data[start:end]):
            raise ValueError('before digest')
        replacement = item['replacement']
        if type(replacement) is not str or len(replacement.encode()) > MAX_BYTES:
            raise ValueError('replacement size')
        hunk = {**item, 'expected_file_digest':sha(data)}
        hunk['id'] = sha(canonical({'binding':binding, 'hunk':hunk}))
        hunks.append(hunk)
    input_ids = [h['id'] for h in hunks]
    retained_groups = []
    if groups is not None:
        if type(groups) is not list or len(groups) > 500:
            raise ValueError('hunk groups count')
        seen = set()
        for group in groups:
            if type(group) is not list or not 2 <= len(group) <= len(proposals):
                raise ValueError('hunk groups need2 or more indexes')
            if any(type(i) is not int or not 0 <= i < len(input_ids) for i in group):
                raise ValueError('hunk group index')
            if len(set(group)) != len(group) or seen.intersection(group):
                raise ValueError('hunk groups must be disjoint')
            seen.update(group)
            retained_groups.append(sorted(input_ids[i] for i in group))
    hunks.sort(key=lambda h:(h['path'], h['start_byte'], h['end_byte']))
    for left, right in zip(hunks, hunks[1:]):
        if left['path'] == right['path'] and (
                right['start_byte'] < left['end_byte'] or right['start_byte'] == left['start_byte']
                or (right['start_byte'] == left['end_byte'] and (
                    left['start_byte'] == left['end_byte'] or right['start_byte'] == right['end_byte']))):
            raise ValueError('overlapping or ambiguous hunks')
    result = {'schema':'omegacode-scoped-suggestion-v1', 'binding':dict(binding),
              'scope':{p:[list(r) for r in trusted_ranges[p]] for p in sorted(trusted_ranges)}, 'hunks':hunks}
    if retained_groups:
        result['hunk_groups'] = sorted(retained_groups)
    result['digest'] = sha(canonical(result))
    # Caller mutation cannot alter retained data through aliasing.
    return json.loads(canonical(result))



# Controller lifecycle uses the SAME bounded Hive transport. These value checks
# do not authenticate claims; the original Host issuer and proved agent relay do.
def _test_ref(value, pattern=r"[A-Za-z0-9_.:-]{1,200}"):
    require(type(value) is str and re.fullmatch(pattern, value) is not None, "test_reference")
    return value


def _test_sha(value):
    return _test_ref(value, r"sha256:[0-9a-f]{64}")


def _test_int(value, low, high):
    require(type(value) is int and low <= value <= high, "test_integer")
    return value


def _test_proposal(value):
    require(type(value) is dict and set(value) == {"proposal_id", "proposal_digest", "normalized_hunks_digest"}, "test_proposal")
    _test_ref(value["proposal_id"], r"suggestion_[0-9a-f]{32}")
    _test_sha(value["proposal_digest"]); _test_sha(value["normalized_hunks_digest"])


def _test_claims(claims, member):
    fields = {"id", "iss", "aud", "actor", "kind", "task_id", "swarm_id", "repository_id",
              "actions", "paths", "argv_prefixes", "iat", "exp", "max_runs",
              "max_runtime_seconds", "member_hash", "grant_id", "proposal_test"}
    require(type(claims) is dict and set(claims) == fields, "test_claim_shape")
    require(claims["iss"] == "hive" and claims["kind"] == "agent"
            and claims["actions"] == ["proposal-test"] and claims["paths"] == []
            and type(claims["max_runs"]) is int and claims["max_runs"] == 0
            and type(claims["max_runtime_seconds"]) is int and claims["max_runtime_seconds"] == 600,
            "test_exclusive_purpose")
    for name in ("id", "aud", "actor", "task_id", "swarm_id", "repository_id"):
        _test_ref(claims[name])
    require(claims["member_hash"] == sha(member.encode()), "test_member_binding")
    require(all(type(claims[k]) in (int, float) and math.isfinite(claims[k]) for k in ("iat", "exp"))
            and 0 < claims["exp"] - claims["iat"] <= 900
            and claims["iat"] <= time.time() < claims["exp"], "test_claim_time")
    prefixes = claims["argv_prefixes"]
    require(type(prefixes) is list and bool(prefixes)
            and all(type(p) is list and bool(p) and all(type(a) is str and bool(a) and "\x00" not in a for a in p)
                    for p in prefixes), "test_argv_policy")
    p = claims["proposal_test"]
    required = {"purpose", "stage", "test_id", "request_id", "lease_id", "controller_id",
                "execution_goal", "issuer", "origin_scope", "proposal", "parent", "fork", "allowance"}
    require(type(p) is dict and p.get("stage") in ("prepare", "run", "result"), "test_stage")
    require(set(p) == required | ({"origin_grant_id"} if p["stage"] == "result" else set())
            and p["purpose"] == "proposal-test" and p["controller_id"] == claims["actor"], "test_scope")
    _test_ref(p["test_id"], r"pt_[0-9a-f]{24}")
    for name in ("request_id", "lease_id", "controller_id", "execution_goal", "issuer"):
        _test_ref(p[name])
    require(p["issuer"].startswith("user:"), "test_person_origin")
    if p["stage"] == "result":
        require(claims["grant_id"] is None, "test_result_no_work")
        _test_ref(p["origin_grant_id"])
    else:
        _test_ref(claims["grant_id"])
    require(type(p["origin_scope"]) is dict and set(p["origin_scope"]) == {"scope_id", "scope_digest", "generation"}, "test_origin")
    _test_ref(p["origin_scope"]["scope_id"]); _test_sha(p["origin_scope"]["scope_digest"])
    _test_int(p["origin_scope"]["generation"], 1, 2**53)
    _test_proposal(p["proposal"])
    require(type(p["parent"]) is dict and set(p["parent"]) == {"workspace_id", "generation", "tree_digest"}, "test_parent")
    _test_ref(p["parent"]["workspace_id"], r"ws_[0-9a-f]{32}")
    _test_int(p["parent"]["generation"], 1, 2**53); _test_sha(p["parent"]["tree_digest"])
    require(type(p["fork"]) is dict and set(p["fork"]) == {"workspace_id", "preparation_digest"}, "test_fork")
    if p["fork"]["workspace_id"] is None:
        require(p["fork"]["preparation_digest"] is None and p["stage"] != "run", "test_fork")
    else:
        _test_ref(p["fork"]["workspace_id"], r"ws_[0-9a-f]{32}"); _test_sha(p["fork"]["preparation_digest"])
        require(p["fork"]["workspace_id"] != p["parent"]["workspace_id"] and p["stage"] != "prepare", "test_fork")
    a = p["allowance"]
    require(type(a) is dict and set(a) == {"until", "per_launch_max_runtime_seconds", "test", "request", "usd"}, "test_allowance")
    require(type(a["until"]) is str and 1 <= len(a["until"]) <= 100, "test_allowance")
    _test_int(a["per_launch_max_runtime_seconds"], 0, 600)
    for name, runs, seconds in (("test", 4, 600), ("request", 8, 1800)):
        require(type(a[name]) is dict and set(a[name]) == {"runs_remaining", "runtime_seconds_remaining"}, "test_allowance")
        _test_int(a[name]["runs_remaining"], 0, runs); _test_int(a[name]["runtime_seconds_remaining"], 0, seconds)
    require(type(a["usd"]) is dict and set(a["usd"]) == {"metered","status","advisory_remaining_usd"}
            and a["usd"]["metered"] is False and a["usd"]["status"] == "unknown"
            and a["usd"]["advisory_remaining_usd"] is None, "test_allowance")
    return p


def _test_public(p):
    # No bearer, raw claims, grant, member identity, operator data or source body.
    return {"test_id": p["test_id"], "request_id": p["request_id"],
            "proposal": decode(canonical(p["proposal"])), "parent": decode(canonical(p["parent"])),
            "fork": decode(canonical(p["fork"]))}


def _test_policy(claims):
    p = claims["proposal_test"]; a = p["allowance"]
    return {"metadata_only":True,"stage":p["stage"],"runtime":"python",
            "permitted_argv_prefixes":decode(canonical(claims["argv_prefixes"])),
            "signed_max_runtime_seconds":600,"dynamic_max_runtime_seconds":a["per_launch_max_runtime_seconds"],
            "test_remaining":decode(canonical(a["test"])),"request_remaining":decode(canonical(a["request"])),
            "capability_expires_at":claims["exp"],"original_allowance_until":a["until"]}


def _test_binding(binding, claims, command=None):
    p = claims["proposal_test"]
    keys = {"schema", "service_id", "capability_id", "test_id", "request_id", "lease_id", "controller_id",
            "issuer", "repository_id", "proposal", "parent", "fork", "test_tree_digest", "runtime", "argv", "runtime_seconds"}
    require(type(binding) is dict and set(binding) == keys and binding["schema"] == "omegacode-project-test-binding/1", "test_result_binding")
    require(all(binding[k] == p[k] for k in ("test_id", "request_id", "lease_id", "controller_id", "issuer", "proposal", "parent", "fork"))
            and binding["service_id"] == claims["aud"] and binding["repository_id"] == claims["repository_id"], "test_result_binding")
    _test_ref(binding["capability_id"]); _test_sha(binding["test_tree_digest"])
    require(binding["runtime"] == "python" and type(binding["argv"]) is list and 1 <= len(binding["argv"]) <= 32
            and all(type(a) is str and a and "\x00" not in a and len(a.encode()) <= 4096 for a in binding["argv"]), "test_result_command")
    _test_int(binding["runtime_seconds"], 6, 120)
    if command is not None:
        require(all(binding[k] == command[k] for k in ("runtime", "argv", "runtime_seconds")), "test_original_command")


def _test_summary(record, claims, launch_key, currency, execution_currency, tested, command=None, *, redactions=(), log_budget=6000):
    require(currency in ("current", "stale", "unknown") and execution_currency in ("current", "stale", "unknown")
            and type(tested) is bool, "test_currency")
    p = claims["proposal_test"]
    base = {**_test_public(p), "launch_key": launch_key, "currency": currency,
            "execution_currency": execution_currency, "tested": False, "accepted_source": False,
            "independent_evaluation": False, "policy":_test_policy(claims), "logs": {}}
    if record is None:
        require(tested is False, "test_missing_receipt")
        return dict(base, status="CONTROLLER_TEST_UNKNOWN", outcome_unknown=True)
    require(type(record) is dict and record.get("test_id") == p["test_id"]
            and record.get("launch_key") == launch_key, "test_response_binding")
    if record.get("schema") == "omegacode-sandbox-dispatch/1":
        require(record.get("state") == "dispatch_unresolved" and tested is False, "test_unresolved")
        _test_binding(record["binding"], claims, command)
        return dict(base, status="CONTROLLER_TEST_UNRESOLVED", outcome_unknown=True)
    require(record.get("schema") == "omegacode-sandbox-dispatch-result/1", "test_result_shape")
    receipt = record["receipt"]
    require(type(receipt) is dict and receipt.get("schema") == "omegacode-sandbox-test-result/1"
            and receipt.get("digest") == "sha256:" + sha(canonical({k: v for k, v in receipt.items() if k != "digest"}))
            and receipt.get("accepted_source") is False and receipt.get("independent_evaluation") is False,
            "test_receipt_integrity")
    _test_binding(receipt["binding"], claims, command)
    _test_sha(receipt["snapshot_digest"])
    streams, captures = receipt["streams"], record.get("captures")
    require(type(streams) is dict and set(streams) == {"stdout", "stderr"}
            and type(captures) is dict and not(set(captures)-{"stdout", "stderr"}), "test_captures")
    _test_int(log_budget, 0, 6000)
    remaining = log_budget
    for name, cap in (("stderr", 16*1024), ("stdout", 256*1024)):
        meta = streams[name]
        require(type(meta) is dict and set(meta) == {"digest", "retained_bytes", "observed_bytes", "eof", "truncated", "complete"}
                and all(type(meta[k]) is bool for k in ("eof", "truncated", "complete")), "test_stream")
        if name not in captures:
            require(meta["digest"] is None and meta["retained_bytes"] is None and meta["complete"] is False, "test_capture_missing")
            continue
        encoded = captures[name]
        require(type(encoded) is str and len(encoded) <= 4*((cap+2)//3), "test_capture_bound")
        import base64
        raw = base64.b64decode(encoded, validate=True)
        require(len(raw) <= cap and base64.b64encode(raw).decode("ascii") == encoded
                and meta["digest"] == "sha256:"+sha(raw) and type(meta["retained_bytes"]) is int
                and meta["retained_bytes"] == len(raw), "test_capture_integrity")
        require(meta["observed_bytes"] is None or type(meta["observed_bytes"]) is int and meta["observed_bytes"] >= len(raw), "test_stream_count")
        if meta["complete"]:
            require(type(meta["observed_bytes"]) is int and meta["observed_bytes"] == len(raw)
                    and meta["eof"] is True and meta["truncated"] is False, "test_complete_stream")
        text = raw.decode("utf-8", "replace")
        redacted = False
        for secret in redactions:
            if secret and secret in text:
                text = text.replace(secret,"[REDACTED_CREDENTIAL]"); redacted = True
        excerpt = text[:remaining]; remaining -= len(excerpt)
        base["logs"][name] = {"classification": "UNTRUSTED_DATA", "encoding": "utf-8-with-replacement",
            "text": excerpt, "text_truncated": len(text) > len(excerpt), "credential_redacted":redacted,
            **{k: meta[k] for k in ("digest", "retained_bytes", "observed_bytes", "eof", "truncated")},
            "full_capture_locator": {"test_id": p["test_id"], "launch_key": launch_key,
                                     "receipt_digest": receipt["digest"], "field": "captures."+name,
                                     "route":"/v1/proposal-tests/"+p["test_id"],"query":{"launch_key":launch_key}}}
    require(receipt.get("command_outcome") in ("succeeded","not_succeeded","unknown")
            and type(receipt.get("output_complete")) is bool
            and (receipt.get("exit_code") is None or type(receipt["exit_code"]) is int), "test_outcome")
    cleanup = receipt["cleanup"]
    require(type(cleanup) is dict and type(cleanup.get("errors")) is list, "test_cleanup")
    require(all(cleanup.get(k) is None or type(cleanup[k]) is bool for k in
                ("complete","original_process_reaped","original_group_absent","job_removed"))
            and cleanup.get("descendants") in (None,"UNRESOLVED","PID_NAMESPACE_TERMINATED","FORK_DENIED","UNPROVEN_DETACHED_MAC"), "test_cleanup_fields")
    success = (receipt.get("command_outcome") == "succeeded" and receipt.get("exit_code") == 0
        and type(receipt.get("exit_code")) is int and receipt.get("output_complete") is True
        and cleanup.get("complete") is True and cleanup.get("original_process_reaped") is True
        and cleanup.get("original_group_absent") is True and cleanup.get("job_removed") is True
        and ((receipt.get("execution_backend") == "landlock" and cleanup.get("descendants") == "PID_NAMESPACE_TERMINATED")
             or (receipt.get("execution_backend") == "sandbox-exec" and cleanup.get("descendants") == "FORK_DENIED"))
        and cleanup["errors"] == [] and receipt.get("primary_error") is None
        and receipt.get("authorization_error") is None and all(streams[k]["complete"] for k in streams))
    require(not tested or currency == execution_currency == "current" and success, "test_positive_projection")
    base.update(status="CONTROLLER_TEST_OBSERVED", outcome_unknown=receipt.get("command_outcome") == "unknown",
        tested=tested, command_outcome=receipt.get("command_outcome"), exit_code=receipt.get("exit_code"),
        receipt_digest=receipt["digest"], snapshot_digest=receipt["snapshot_digest"],
        command_digest=sha(canonical(receipt["binding"]["argv"])),
        cleanup={k: cleanup.get(k) for k in ("complete", "original_process_reaped", "original_group_absent", "job_removed", "descendants")},
        cleanup_error_count=len(cleanup["errors"]))
    return base


class DelegatedProposalClient:
    """One bounded existing host purpose, without ordinary-capability fallback."""
    def __init__(self, hive_url, member_token, *, transport=None):
        require(type(hive_url) is str and type(member_token) is str and bool(member_token),
                "member_configuration")
        self.hive_url = hive_url.rstrip("/")
        self._member_token = member_token
        self._http = httpx.Client(timeout=20, transport=transport, follow_redirects=False)

    def close(self):
        self._http.close()

    def _json(self, method, path, *, bearer=None, params=None, body=None,
              _expected=(200, 201)):
        require(_expected in ((200, 201), (200, 201, 202)), "response_status_contract")
        headers = {"Authorization": "Bearer " + (bearer or self._member_token)}
        if bearer is not None:
            headers["X-Hive-Token"] = self._member_token
        raw = None if body is None else canonical(body)
        require(raw is None or len(raw) <= MAX_BODY, "request_cap")
        if raw is not None:
            headers["Content-Type"] = "application/json"
        with self._http.stream(method, self.hive_url + path, params=params,
                               content=raw, headers=headers) as response:
            chunks, amount = [], 0
            for chunk in response.iter_bytes():
                amount += len(chunk)
                require(amount <= MAX_RESPONSE, "response_cap")
                chunks.append(chunk)
            value = decode(b"".join(chunks))
            if response.status_code not in _expected:
                code = value.get("error") if type(value) is dict else None
                if type(code) is dict:
                    code = code.get("code")
                if type(code) is not str or REF.fullmatch(code) is None:
                    code = "host_or_service_refused"
                raise ProposalRefused(code, "http")
            require(type(value) is dict, "response_shape")
            return value

    def _issue(self):
        answer = self._json("POST", "/api/agent/code/capability",
                            body={"service": "omegacode", "delegated": True})
        require(set(answer) == {"token", "claims"}, "capability_shape")
        token, claims = answer["token"], answer["claims"]
        require(type(token) is str and token.startswith("hc1.") and type(claims) is dict,
                "capability_shape")
        required = {"id", "iss", "aud", "actor", "kind", "task_id", "swarm_id",
                    "repository_id", "actions", "paths", "argv_prefixes", "iat", "exp",
                    "max_runs", "max_runtime_seconds", "member_hash", "grant_id", "delegated"}
        require(set(claims) == required, "capability_shape")
        require(claims["iss"] == "hive" and claims["kind"] == "agent", "purpose_required")
        require(claims["actions"] == ["read", "search", "suggest"], "purpose_required")
        require(claims["paths"] == [] and claims["argv_prefixes"] == [], "purpose_shape")
        for key in ("id", "aud", "task_id", "swarm_id", "repository_id"):
            ref(claims[key])
        require(type(claims["actor"]) is str and bool(claims["actor"]), "actor")
        require(claims["member_hash"] == sha(self._member_token.encode()), "member_binding")
        require(all(type(claims[k]) in (int, float) and math.isfinite(claims[k])
                    for k in ("iat", "exp")), "capability_time")
        require(0 < claims["exp"] - claims["iat"] <= 900, "capability_time")
        delegated = claims["delegated"]
        require(type(delegated) is dict and set(delegated) == {
            "request_id", "controller_id", "execution_goal", "issuer", "origin_scope"}, "delegation")
        for key in ("request_id", "controller_id", "execution_goal"):
            ref(delegated[key])
        require(type(delegated["issuer"]) is str and delegated["issuer"].startswith("user:")
                and delegated["issuer"] != "user:operator", "person_origin")
        ceiling = delegated["origin_scope"]
        require(type(ceiling) is dict and set(ceiling) == {
            "scope_id", "scope_digest", "generation"}, "scope_ceiling")
        ref(ceiling["scope_id"])
        require(type(ceiling["scope_digest"]) is str and
                re.fullmatch(r"sha256:[a-f0-9]{64}", ceiling["scope_digest"]) is not None,
                "scope_digest")
        require(type(ceiling["generation"]) is int and ceiling["generation"] > 0, "generation")
        return token, claims

    def _relay(self, token, method, path, *, params=None, body=None):
        return self._json(method, "/api/agent/code/relay" + path,
                          bearer=token, params=params, body=body)

    def _scope(self, workspace_id):
        require(type(workspace_id) is str and workspace_id.startswith("ws_"), "workspace_id_required")
        ref(workspace_id, "ws_")
        token, claims = self._issue()
        ceiling = claims["delegated"]["origin_scope"]
        scope = self._relay(token, "GET", f"/v1/workspaces/{workspace_id}/suggestion-scopes/{ceiling['scope_id']}")
        require("schema" not in scope, "canvas_v1_text_scope_required")
        require(set(scope) == {"id", "workspace_id", "digest", "author", "created_at",
                               "binding", "ranges", "file_digests", "edit_authority", "currency"},
                "scope_receipt")
        require(scope["id"] == ceiling["scope_id"] and scope["workspace_id"] == workspace_id
                and "sha256:" + scope["digest"] == ceiling["scope_digest"]
                and scope["author"] == claims["delegated"]["issuer"]
                and scope["edit_authority"] is False and scope["currency"] == "current", "scope_binding")
        binding = scope["binding"]
        require(type(binding) is dict and set(binding) == {
            "workspace_id", "task_id", "generation", "tree_digest"}, "scope_binding")
        require(binding["workspace_id"] == workspace_id and binding["task_id"] == claims["task_id"]
                and type(binding["generation"]) is int and binding["generation"] == ceiling["generation"]
                and type(binding["tree_digest"]) is str and HEX.fullmatch(binding["tree_digest"]) is not None,
                "scope_binding")
        require(type(scope["ranges"]) is dict and type(scope["file_digests"]) is dict and
                1 <= len(scope["ranges"]) <= 100 and set(scope["ranges"]) == set(scope["file_digests"]),
                "scope_paths")
        for name, ranges in scope["ranges"].items():
            require(type(name) is str and bool(name) and type(ranges) is list and 1 <= len(ranges) <= 100,
                    "scope_paths")
            require(type(scope["file_digests"][name]) is str and HEX.fullmatch(scope["file_digests"][name]) is not None,
                    "file_digest")
            for pair in ranges:
                require(type(pair) is list and len(pair) == 2 and all(type(v) is int for v in pair)
                        and 0 <= pair[0] <= pair[1] <= MAX_FILE, "scope_range")
        return token, claims, scope

    def context(self, workspace_id):
        _, claims, scope = self._scope(workspace_id)
        return {"status": "PERSON_SCOPE_OBSERVED", "delegated": claims["delegated"],
                "repository_id": claims["repository_id"], "scope": scope,
                "authority": "retained-proposal-only; person decides"}

    def _read(self, token, scope, path):
        require(type(path) is str and path in scope["ranges"], "path_outside_person_scope")
        row = self._relay(token, "GET", f"/v1/workspaces/{scope['workspace_id']}/files",
                          params={"path": path, "expected_generation": scope["binding"]["generation"]})
        require(set(row) == {"path", "content", "digest", "generation", "tree_digest"}
                and type(row["content"]) is str, "file_receipt")
        raw = row["content"].encode("utf-8", "strict")
        require(len(raw) <= MAX_FILE and row["path"] == path
                and row["digest"] == scope["file_digests"][path] == sha(raw)
                and type(row["generation"]) is int and row["generation"] == scope["binding"]["generation"]
                and row["tree_digest"] == scope["binding"]["tree_digest"], "file_binding")
        return row

    def read(self, workspace_id, path):
        token, _, scope = self._scope(workspace_id)
        row = self._read(token, scope, path)
        raw = row["content"].encode("utf-8", "strict")
        ranges = []
        for start, end in scope["ranges"][path]:
            require(boundary(raw, start) and boundary(raw, end), "scope_utf8_boundary")
            ranges.append({"start_byte": start, "end_byte": end,
                           "before_digest": sha(raw[start:end])})
        return {**row, "person_ranges": ranges}

    def propose(self, workspace_id, operation_id, hunks):
        """Same operation/body on retry; a lost post/readback is explicitly UNKNOWN."""
        ref(operation_id)
        require(type(hunks) is list and 1 <= len(hunks) <= 1000, "hunks")
        # Snapshot the actual input, not a caller-owned mutable object used after IO.
        raw = canonical(hunks)
        require(len(raw) <= MAX_BODY, "request_cap")
        hunks = decode(raw)
        token, claims, scope = self._scope(workspace_id)
        require(all(type(h) is dict and type(h.get("path")) is str for h in hunks), "hunks")
        files = {p: self._read(token, scope, p)["content"].encode("utf-8") for p in sorted({h["path"] for h in hunks})}
        # Live attempt 17: a mind lost the person range's before_digest from its history and gave up. A hunk that is
        # EXACTLY one of the person's ranges may leave before_digest out: it is taken from the bytes read just now
        # under the scope's bound generation (the same value code-proposal-read shows). Any other hunk still needs it.
        hunks = [dict(h, before_digest=sha(files[h["path"]][h["start_byte"]:h["end_byte"]]))
                 if "before_digest" not in h and type(h.get("start_byte")) is int and type(h.get("end_byte")) is int
                 and [h["start_byte"], h["end_byte"]] in [list(r) for r in scope["ranges"].get(h["path"], [])]
                 else h for h in hunks]
        try:
            expected = prepare(scope["binding"], files, scope["ranges"], hunks)
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise ProposalRefused("hunk_source_or_scope", "validation", operation_id) from None
        payload = {"operation_id": operation_id, "scope_id": scope["id"], "hunks": hunks}
        attempted = False
        phase = "retain"
        try:
            attempted = True
            record = self._relay(token, "POST", f"/v1/workspaces/{workspace_id}/suggestions", body=payload)
            require(set(record) == {"id", "workspace_id", "scope_id", "digest", "author", "created_at"}, "proposal_record")
            ref(record["id"], "suggestion_")
            phase = "readback"
            saved = self._relay(token, "GET", f"/v1/workspaces/{workspace_id}/suggestions/{record['id']}",
                                params={"include_request_binding": "true"})
            content = {**expected, "scope_id": scope["id"], "author": claims["actor"]}
            require(record["workspace_id"] == workspace_id and record["scope_id"] == scope["id"]
                    and record["author"] == claims["actor"] and record["digest"] == sha(canonical(content)),
                    "proposal_record_binding")
            require(set(saved) == {"record", "content", "decisions", "currency", "request_binding"}
                    and saved["record"] == record and saved["content"] == content
                    and type(saved["decisions"]) is list and saved["currency"] in ("current", "stale"),
                    "proposal_readback")
            provenance = {"schema": "omegacode-request-proposal-v1", "workspace_id": workspace_id,
                          "proposal_id": record["id"], "proposal_digest": record["digest"],
                          "author": claims["actor"], "origin_task_id": claims["task_id"],
                          "origin_swarm_id": claims["swarm_id"], "repository_id": claims["repository_id"],
                          "delegated": claims["delegated"]}
            require(saved["request_binding"] == {"digest": sha(canonical(provenance)), "content": provenance},
                    "request_provenance")
            return {"status": "RETAINED_PERSON_REVIEW_REQUIRED", "operation_id": operation_id,
                    "record": record, "request_binding": saved["request_binding"],
                    "currency": saved["currency"], "applied": False}
        except (httpx.HTTPError, ProposalRefused, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            # A malformed/lost answer is not proof that the post failed to commit.
            raise ProposalRefused("proposal_outcome_unknown", phase, operation_id, attempted) from None


    def _test_issue(self, body):
        try:
            answer = self._json("POST", "/api/agent/code/capability",
                                body={"service": "omegacode", "proposal_test": body})
            require(set(answer) == {"token", "claims"} and type(answer["token"]) is str
                    and re.fullmatch(r"hc1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}", answer["token"]) is not None,
                    "test_capability_shape")
            p = _test_claims(answer["claims"], self._member_token)
            if "test_id" in body:
                require(p["test_id"] == body["test_id"] and p["stage"] == body["stage"], "test_issued_stage")
            else:
                require(p["stage"] in ("prepare", "run") and p["request_id"] == body["request_id"]
                        and p["proposal"] == body["proposal"]
                        and {k:p["parent"][k] for k in ("generation", "tree_digest")} == body["parent"], "test_issued_origin")
            return answer["token"], answer["claims"]
        except (httpx.HTTPError, ProposalRefused, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            original = body.get("operation_id")
            raise ProposalRefused("test_capability_outcome_unknown" if original else "test_capability_refused",
                                  "capability", original, original is not None) from None

    def test_context(self, request_id, proposal_id):
        """The controller's own host lookup of one retained proposal's test references. The digests and parent come
        only from the host (which authenticates the proposal in the original person scope and checks request, lease,
        controller and child-author binding); nothing here is model-supplied except the two ids."""
        _test_ref(request_id, r"rq_[A-Za-z0-9_-]{1,120}"); _test_ref(proposal_id, r"suggestion_[0-9a-f]{32}")
        try:
            value = self._json("POST", "/api/agent/code/test-context",
                               body={"request_id": request_id, "proposal_id": proposal_id})
        except ProposalRefused as refused:
            raise ProposalRefused(refused.code, "context") from None
        except (httpx.HTTPError, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise ProposalRefused("test_context_unavailable", "context") from None
        require(set(value) == {"schema", "request_id", "lease_id", "receiving_goal", "proposal", "parent",
                               "context_only", "execution_authority"}
                and value["schema"] == "hive.controller-code-test-lookup/1" and value["request_id"] == request_id
                and value["context_only"] is True and value["execution_authority"] is False, "test_context_shape")
        _test_proposal(value["proposal"])
        require(value["proposal"]["proposal_id"] == proposal_id, "test_context_proposal")
        parent = value["parent"]
        require(type(parent) is dict and set(parent) == {"workspace_id", "generation", "tree_digest"}, "test_context_parent")
        _test_ref(parent["workspace_id"], r"ws_[0-9a-f]{32}")
        _test_int(parent["generation"], 1, 2**53); _test_sha(parent["tree_digest"])
        return value

    def test_prepare_simple(self, request_id, operation_id, proposal_id):
        """code-test-prepare rq_id operation proposal_id: host-filled digests and parent, then the unchanged prepare."""
        _test_ref(operation_id, r"[A-Za-z0-9_.:-]{8,120}")
        context = self.test_context(request_id, proposal_id)
        parent = {k: context["parent"][k] for k in ("generation", "tree_digest")}
        result = self.test_prepare(request_id, operation_id, context["proposal"], parent)
        result["filled_from"] = "host_test_context"
        return result

    def test_prepare(self, request_id, operation_id, proposal, parent):
        _test_ref(request_id); _test_ref(operation_id, r"[A-Za-z0-9_.:-]{8,120}")
        require(operation_id != self._member_token, "private_credential_argument")
        proposal, parent = decode(canonical(proposal)), decode(canonical(parent))
        _test_proposal(proposal)
        require(type(parent) is dict and set(parent) == {"generation", "tree_digest"}, "test_original_parent")
        _test_int(parent["generation"], 1, 2**53); _test_sha(parent["tree_digest"])
        body = {"operation_id":operation_id, "request_id":request_id, "proposal":proposal, "parent":parent}
        try:
            token, claims = self._test_issue(body)
            p = claims["proposal_test"]
            if p["stage"] == "run":
                return {**_test_public(p), "status":"HOST_PREPARATION_ALREADY_BOUND",
                        "operation_id":operation_id, "policy":_test_policy(claims), "launch_authority":False, "accepted_source":False}
            value = self._json("POST", "/api/agent/code/relay/v1/proposal-tests", bearer=token, body={})
            require(set(value) == {"test_id", "ack", "launch_authority", "accepted_source"}
                    and value["test_id"] == p["test_id"] and value["launch_authority"] is False
                    and value["accepted_source"] is False, "test_prepare_receipt")
            ack = value["ack"]
            require(type(ack) is dict and set(ack) == {"test_id", "fork_workspace_id", "test_tree_digest", "preparation_digest", "bound_at"}
                    and ack["test_id"] == p["test_id"], "test_prepare_receipt")
            _test_ref(ack["fork_workspace_id"], r"ws_[0-9a-f]{32}")
            require(ack["fork_workspace_id"] != p["parent"]["workspace_id"], "test_prepare_fork")
            _test_sha(ack["test_tree_digest"]); _test_sha(ack["preparation_digest"])
            require(type(ack["bound_at"]) is str and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z",ack["bound_at"]) is not None, "test_prepare_time")
            return {**_test_public(p), "status":"CONTROLLER_TEST_PREPARED", "operation_id":operation_id,
                    "preparation":decode(canonical(ack)), "policy":_test_policy(claims),
                    "fork":{"workspace_id":ack["fork_workspace_id"],"preparation_digest":ack["preparation_digest"]},
                    "launch_authority":False, "accepted_source":False}
        except (httpx.HTTPError, ProposalRefused, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise ProposalRefused("test_prepare_outcome_unknown", "prepare", operation_id, True) from None

    def test_run(self, test_id, launch_key, command, *, simple=None):
        _test_ref(test_id, r"pt_[0-9a-f]{24}"); _test_ref(launch_key, r"[A-Za-z0-9_.:-]{8,120}")
        require(launch_key != self._member_token, "private_credential_argument")
        if simple is not None:
            # Simple form: the command is derived from the operator's signed argv prefixes on the run claim, never guessed.
            words = _simple_run_words(simple)
            token, claims = self._test_issue({"test_id":test_id, "stage":"run"})
            command = simple_run_command(claims["argv_prefixes"], words)
        command = decode(canonical(command))
        require(type(command) is dict and set(command) == {"runtime", "argv", "runtime_seconds"}
                and command["runtime"] == "python" and type(command["argv"]) is list
                and 1 <= len(command["argv"]) <= 32 and all(type(a) is str and a and "\x00" not in a
                and len(a.encode()) <= 4096 for a in command["argv"]), "test_command")
        _test_int(command["runtime_seconds"], 6, 120)
        if simple is None:
            token, claims = self._test_issue({"test_id":test_id, "stage":"run"})
        # The same original key/body must remain recoverable when a prior hold
        # consumed the allowance or operator prefixes changed. Only the original
        # Host/retained service handler decides replay versus a new admission.
        body = {"launch_key":launch_key, **command}
        try:
            value = self._json("POST", "/api/agent/code/relay/v1/proposal-tests/"+test_id+"/launches",
                bearer=token, body=body, _expected=(200,201,202))
            require(set(value) == {"record","currency","execution_currency","tested","accepted_source"}
                    and value["accepted_source"] is False, "test_launch_projection")
            result = _test_summary(value["record"], claims, launch_key, value["currency"],
                                   value["execution_currency"], value["tested"], command, redactions=(self._member_token,token))
            result["recovery"] = {"test_id":test_id,"launch_key":launch_key,"body_digest":sha(canonical(body)),
                                  "instruction":"retain original body; explicitly call same key/body; never auto-restart"}
            if simple is not None:
                result["command"] = decode(canonical(command))
            return result
        except (httpx.HTTPError, ProposalRefused, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise ProposalRefused("test_launch_outcome_unknown", "launch", launch_key, True) from None

    def test_result(self, test_id, launch_key=None):
        _test_ref(test_id, r"pt_[0-9a-f]{24}")
        if launch_key is not None: _test_ref(launch_key, r"[A-Za-z0-9_.:-]{8,120}")
        token, claims = self._test_issue({"test_id":test_id,"stage":"result"})
        value = self._json("GET", "/api/agent/code/relay/v1/proposal-tests/"+test_id,
                           bearer=token, params={} if launch_key is None else {"launch_key":launch_key})
        require(set(value) == {"test_id","results","no_work","accepted_source"} and value["test_id"] == test_id
                and value["no_work"] is True and value["accepted_source"] is False
                and type(value["results"]) is list and len(value["results"]) <= 4, "test_history")
        results, seen, remaining = [], set(), 6000
        for entry in value["results"]:
            require(type(entry) is dict and set(entry) == {"test_id","launch_key","result","source_currency",
                "execution_currency","currency","tested","accepted_source"} and entry["test_id"] == test_id
                and entry["source_currency"] == "unknown" and entry["tested"] is False
                and entry["accepted_source"] is False, "test_history_no_work")
            key = _test_ref(entry["launch_key"], r"[A-Za-z0-9_.:-]{8,120}")
            require(key not in seen and (launch_key is None or key == launch_key), "test_history_key")
            seen.add(key)
            projected = _test_summary(entry["result"], claims, key, entry["currency"],entry["execution_currency"],False,
                                      redactions=(self._member_token,token),log_budget=remaining)
            remaining -= sum(len(v["text"]) for v in projected["logs"].values())
            results.append(projected)
        return {"status":"CONTROLLER_TEST_HISTORY", "test_id":test_id,"results":results,
                "no_work":True,"policy":_test_policy(claims),"accepted_source":False}


SIMPLE_PROPOSAL = re.compile(r"suggestion_[0-9a-f]{32}\Z")
SIMPLE_RUN_SECONDS = 10
_PYTHON_WORDS = ("python", "python3")


def _simple_run_words(simple):
    words = simple.split() if type(simple) is str else None
    require(type(words) is list and len(words) <= 32
            and all(w and "\x00" not in w and len(w.encode()) <= 4096 for w in words), "test_simple_command")
    return words


def simple_run_command(prefixes, words):
    """Map the simple run form onto the operator's signed argv prefixes from the run claim.

    No words: the host-declared default, i.e. the one operator prefix when it is a complete python test command
    [exe, file, ...]. 'python file [args]': argv [configured exe, file, args], where the exe is the single absolute
    python executable the operator configured. Either way runtime python and 10 seconds; the argv must start with a
    permitted prefix, otherwise it is refused here before any launch."""
    require(type(prefixes) is list and bool(prefixes), "test_argv_policy")
    exes = sorted({p[0] for p in prefixes if type(p) is list and p and type(p[0]) is str and p[0].startswith("/")
                   and PurePosixPath(p[0]).name.startswith("python")})
    if not words:
        # The default: the one operator prefix when there is only one, else the ONE plain 'python <file>.py' prefix
        # among several (live Code test 19: a python file command beside a unittest-discover one). Two or more plain
        # file commands stay ambiguous: the mind names the file.
        plain = [p for p in prefixes if type(p) is list and len(p) == 2 and p[0] in exes and type(p[1]) is str
                 and p[1].endswith(".py") and not p[1].startswith("-")]
        if len(prefixes) == 1 and len(prefixes[0]) >= 2 and prefixes[0][0] in exes:
            argv = list(prefixes[0])
        else:
            require(len(plain) == 1, "test_default_command_unknown")
            argv = list(plain[0])
    else:
        require(len(exes) == 1, "test_python_exe_not_configured")
        require(words[0] in _PYTHON_WORDS or words[0] == exes[0], "test_simple_command_is_python_file")
        require(len(words) >= 2, "test_simple_command_is_python_file")
        argv = [exes[0], *words[1:]]
    require(any(argv[:len(p)] == p for p in prefixes), "test_command_outside_operator_prefix")
    return {"runtime": "python", "argv": argv, "runtime_seconds": SIMPLE_RUN_SECONDS}


def _argument(value):
    """MeTTa text argument, with JSON string quoting when the runtime retains it."""
    text = str(value).strip()
    if text.startswith('"'):
        text = decode(text.encode("utf-8", "strict"))
        require(type(text) is str, "text_argument")
    return text


def helper_instruction():
    """code-helper-instruction: the request helper reads its own request's instruction. No argument: the host binds the
    request to this helper, so another request can never be named. The text is the person's words (UNTRUSTED_DATA)."""
    client, result = None, None
    try:
        hive, member = os.environ.get("HIVE_API_URL"), os.environ.get("HIVE_WS_TOKEN")
        require(type(hive) is str and type(member) is str and bool(hive) and bool(member), "member_configuration")
        client = DelegatedProposalClient(hive, member)
        value = client._json("GET", "/api/agent/code/helper-instruction")
        require(value.get("schema") == "hive.code-helper-instruction/1" and type(value.get("instruction")) is dict,
                "instruction_shape")
        result = {"status": "REQUEST_INSTRUCTION", **{k: value.get(k) for k in (
            "request_id", "title", "workspace_id", "classification", "instruction", "authority")}}
    except ProposalRefused as error:
        result = {"status": "INSTRUCTION_REFUSED", "code": error.code}
    except Exception:
        result = {"status": "INSTRUCTION_REFUSED", "code": "instruction_client_failed"}
    finally:
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()
    return json.dumps(result, sort_keys=True, ensure_ascii=True, allow_nan=False).replace(";", "\\u003b")


def _skill(action, workspace, *args):
    client, result, primary, close_failed = None, None, None, False
    operation_id = None
    try:
        hive, member = os.environ.get("HIVE_API_URL"), os.environ.get("HIVE_WS_TOKEN")
        require(type(hive) is str and type(member) is str and bool(hive) and bool(member), "member_configuration")
        client = DelegatedProposalClient(hive, member)
        workspace = _argument(workspace)
        if action == "context":
            result = client.context(workspace)
        elif action == "read":
            result = client.read(workspace, _argument(args[0]))
        elif action == "propose":
            operation_id = _argument(args[0])
            raw = _argument(args[1]).encode("utf-8", "strict")
            require(len(raw) <= MAX_BODY, "request_cap")
            hunks = decode(raw)
            if type(hunks) is dict and set(hunks) == {"hunks"}:
                hunks = hunks["hunks"]   # live attempt 15: a mind wrapped the list as {"hunks": [...]}; the meaning is the same
            result = client.propose(workspace, operation_id, hunks)
        else:
            raise ProposalRefused("unsupported_proposal_skill", "validation")
    except Exception as error:
        primary = error
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                close_failed = True
    if primary is not None:
        result = {"status": "PROPOSAL_REFUSED", "operation_id": operation_id,
                  "code": primary.code if type(primary) is ProposalRefused else "proposal_client_failed",
                  "phase": primary.phase if type(primary) is ProposalRefused else "client",
                  "outcome_unknown": primary.outcome_unknown if type(primary) is ProposalRefused else action == "propose"}
        if result["code"] in PLAIN_REFUSALS:
            result["message"] = PLAIN_REFUSALS[result["code"]]
    if close_failed:
        result = {"status": "PROPOSAL_CLIENT_CLOSE_UNKNOWN", "result": result,
                  "close_debt": True, "operation_id": operation_id}
    # Valid JSON escapes keep MeTTa's semicolon comment parser out of source text.
    return json.dumps(result, sort_keys=True, ensure_ascii=True, allow_nan=False).replace(";", "\\u003b")


# One plain MeTTa-safe line per refusal a mind can fix itself: no quotes, brackets or semicolons.
PLAIN_REFUSALS = {
    "workspace_id_required": "This takes the workspace id ws_... named in your task, not a request id rq_... "
                             "or a goal id g_... - repeat with the ws_ id.",
    "hunks": "JSON_hunks is a JSON list of objects, each with path, start_byte, end_byte, replacement and before_digest "
             "- before_digest is the one code-proposal-read gives in person_ranges, or leave it out when the hunk is exactly a person range. Repeat with the same operation id.",
    "test_default_command_unknown": "Name the test: code-test-run pt_id new_key python test_file.py - the file must be one "
                                    "of the operator commands listed in permitted_argv_prefixes from code-test-prepare.",
    "hunk_source_or_scope": "A hunk is outside the person's scope or its before_digest does not match - use the exact "
                            "start_byte, end_byte and before_digest from code-proposal-context person_ranges.",
}


def proposal_context(workspace):
    return _skill("context", workspace)


def proposal_read(workspace, path):
    return _skill("read", workspace, path)


def propose(workspace, operation_id, hunks_json):
    return _skill("propose", workspace, operation_id, hunks_json)



def _controller_skill(action, first, *args):
    client, result, primary, close_failed = None, None, None, False
    original_key = None
    try:
        hive, member = os.environ.get("HIVE_API_URL"), os.environ.get("HIVE_WS_TOKEN")
        require(type(hive) is str and type(member) is str and bool(hive) and bool(member), "member_configuration")
        client = DelegatedProposalClient(hive, member)
        first = _argument(first)
        def data(value):
            raw = _argument(value).encode("utf-8", "strict")
            require(len(raw) <= MAX_BODY, "request_cap")
            return decode(raw)
        if action == "prepare":
            candidate_key = _argument(args[0])
            _test_ref(candidate_key, r"[A-Za-z0-9_.:-]{8,120}")
            require(candidate_key != member, "private_credential_argument")
            original_key = candidate_key
            text = _argument(args[1])
            if SIMPLE_PROPOSAL.fullmatch(text):
                # simple form: only the proposal id; digests and parent come from the host, never the caller
                result = client.test_prepare_simple(first, original_key, text)
            else:
                preparation = data(args[1])
                require(type(preparation) is dict and set(preparation) == {"proposal","parent"}, "test_original_preparation")
                result = client.test_prepare(first, original_key, preparation["proposal"], preparation["parent"])
        elif action == "run":
            candidate_key = _argument(args[0])
            _test_ref(candidate_key, r"[A-Za-z0-9_.:-]{8,120}")
            require(candidate_key != member, "private_credential_argument")
            original_key = candidate_key
            text = _argument(args[1]) if len(args) > 1 else ""
            if text.startswith("{"):
                result = client.test_run(first, original_key, data(args[1]))
            else:
                result = client.test_run(first, original_key, None, simple=text)
        elif action == "result":
            query = data(args[0])
            require(type(query) is dict and not(set(query)-{"launch_key"}), "test_result_selection")
            if "launch_key" in query: _test_ref(query["launch_key"], r"[A-Za-z0-9_.:-]{8,120}")
            result = client.test_result(first, query.get("launch_key"))
        else:
            raise ProposalRefused("unsupported_controller_test_skill", "validation")
    except Exception as error:
        primary = error
    finally:
        if client is not None:
            try: client.close()
            except Exception: close_failed = True
    if primary is not None:
        result = {"status":"CONTROLLER_TEST_REFUSED", "original_key":original_key,
                  "code":primary.code if type(primary) is ProposalRefused else "test_client_failed",
                  "phase":primary.phase if type(primary) is ProposalRefused else "client",
                  "outcome_unknown":primary.outcome_unknown if type(primary) is ProposalRefused else action in ("prepare","run")}
        if result["code"] in PLAIN_REFUSALS:
            result["message"] = PLAIN_REFUSALS[result["code"]]
    if close_failed:
        result = {"status":"CONTROLLER_TEST_CLIENT_CLOSE_UNKNOWN","result":result,"close_debt":True,"original_key":original_key}
    return json.dumps(result,sort_keys=True,ensure_ascii=True,allow_nan=False).replace(";","\\u003b")


def proposal_test_prepare(request_id, operation_id, preparation_json):
    return _controller_skill("prepare", request_id, operation_id, preparation_json)


def proposal_test_run(test_id, launch_key, command_json=""):
    return _controller_skill("run", test_id, launch_key, command_json)


def proposal_test_result(test_id, query_json):
    return _controller_skill("result", test_id, query_json)
