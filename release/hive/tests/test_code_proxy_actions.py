"""Each relayed OmegaCode route gets exactly its minimal actions (Code PROXY_ACTIONS_RESPONSE, Kimi 2026-10-05)."""
import json
import re

from hive.core.code import HUMAN_ACTIONS, PROXY_ROUTES


def route_for(method, path):
    return next(r for r in PROXY_ROUTES if r[0] == method and re.match(r[1], path))


def test_every_route_names_a_nonempty_subset_of_the_vocabulary():
    for method, pattern, actions in PROXY_ROUTES:
        assert actions and set(actions) <= set(HUMAN_ACTIONS), (method, pattern)


def test_read_routes_never_carry_edit_or_run():
    for method, path in (("GET", "/v1/workspaces/ws_a/files"), ("POST", "/v1/workspaces/ws_a/repository-facts"),
                         ("POST", "/v1/workspaces/ws_a/repository-retrieval"), ("GET", "/v1/runs/run_a/source"),
                         ("GET", "/v1/capabilities"), ("POST", "/v1/workspaces/ws_a/reviews")):
        assert not {"edit", "run"} & set(route_for(method, path)[2]), path


def test_the_mapping_matches_codes_table():
    expect = {("POST", "/v1/workspaces/ws_a/patches"): {"edit"},
              ("POST", "/v1/workspaces/ws_a/merges/merge_a/apply"): {"read", "edit"},
              ("POST", "/v1/workspaces/ws_a/git/exports"): {"read", "edit"},
              ("GET", "/v1/runs/run_a/output"): {"read", "events"},
              ("GET", "/v1/runs/run_a/proof-result"): {"read", "events"},
              ("POST", "/v1/workspaces"): {"workspace"}, ("POST", "/v1/runs"): {"run"},
              ("POST", "/v1/runs/run_a/cancel"): {"cancel"}, ("POST", "/v1/verifications"): {"verify"},
              ("POST", "/v1/workspaces/ws_a/checkpoints"): {"checkpoint"}, ("GET", "/v1/events"): {"events"},
              ("GET", "/v1/artifacts/" + "a" * 64): {"artifact"}, ("POST", "/v1/workspaces/ws_a/search"): {"search"}}
    for (method, path), actions in expect.items():
        assert set(route_for(method, path)[2]) == actions, path


def test_capabilities_are_issued_and_cached_per_action_set(monkeypatch):
    from hive.core import code as code_mod
    issued = []

    revoked = set()

    class Services:
        def by_name(self, name): return {"id": "svc"}
        def issue(self, svc, **kw):
            issued.append(tuple(kw["actions"]))
            return {"token": f"t{len(issued)}", "claims": {"exp": 9e12, "id": f"cap{len(issued)}"}}
        def capability_status(self, svc, cap_id): return {"active": cap_id not in revoked}

    class DB:
        def one(self, sql, args): return {"swarm_id": "s_1"}

    hive = type("H", (), {"services": Services(), "db": DB()})()
    c = code_mod.Code.__new__(code_mod.Code)
    c.hive, c._caps, c.repos = hive, {}, {}
    read = c._capability("user:u", "g_1", None, "repo", ("read",))
    edit = c._capability("user:u", "g_1", None, "repo", ("edit",))
    again = c._capability("user:u", "g_1", None, "repo", ("read",))
    assert read != edit and read == again and issued == [("read",), ("edit",)]
    revoked.add("cap1")                                  # Kimi: a revoked capability is never reused from the cache
    fresh = c._capability("user:u", "g_1", None, "repo", ("read",))
    assert fresh != read and issued[-1] == ("read",)


def test_codes_workbench_routes_carry_codes_actions():
    """Code host-workbench-proxy-candidate: nine Workbench routes (four run-result routes held), each with exactly Code's minimal actions."""
    expect = {("POST", "/v1/workspaces/ws_a/suggestion-scopes"): {"read"},
              ("POST", "/v1/workspaces/ws_a/function-scopes"): {"read"},
              ("POST", "/v1/workspaces/ws_a/function-scope-preview"): {"read"},
              ("POST", "/v1/workspaces/ws_a/suggestions"): {"read"},
              ("GET", "/v1/workspaces/ws_a/suggestions"): {"read"},
              ("GET", "/v1/workspaces/ws_a/suggestions/s_1"): {"read"},
              ("POST", "/v1/workspaces/ws_a/suggestion-decisions"): {"edit", "read"},
              ("POST", "/v1/workspaces/ws_a/iterations"): {"checkpoint", "read"},
              ("GET", "/v1/workspaces/ws_a/iterations/it_1"): {"read"}}
    for (method, path), actions in expect.items():
        assert set(route_for(method, path)[2]) == actions, path



def test_run_result_routes_carry_codes_direction_actions():
    """Served by the pinned service (93e49926 onward); adopted with exactly the actions in coordination/omegacode/RUN_RESULT_PROXY_ROUTE_DIRECTION.json."""
    expect = {("POST", "/v1/runs/run_a/results"): {"checkpoint", "read"},
              ("GET", "/v1/workspaces/ws_a/run-results/rr_1"): {"read"},
              ("GET", "/v1/workspaces/ws_a/run-results/rr_1/source"): {"read"},
              ("POST", "/v1/workspaces/ws_a/run-results/rr_1/import"): {"edit", "read"}}
    for (method, path), actions in expect.items():
        routes = [r for r in PROXY_ROUTES if r[0] == method and re.fullmatch(r[1], path)]
        assert len(routes) == 1 and set(routes[0][2]) == actions, (method, path, routes)


def test_the_fork_route_is_held_until_code_names_its_actions():
    """Served by the pinned service but held per Code: not relayed (Platform does not guess authority).
    (proof-result was adopted earlier, eb9a877, with read and events.)"""
    assert not any(r[0] == "POST" and re.fullmatch(r[1], "/v1/workspaces/ws_a/forks") for r in PROXY_ROUTES)


SAMPLE = {"workspaces": "ws_a", "runs": "run_a", "merges": "merge_a", "exports": "gx_a", "reviews": "review_a",
          "hunks": "h_" + "a" * 64, "run-results": "rr_a", "terminal": "tc_a", "tasks": "g_a", "artifacts": "a" * 64,
          "proposal-applications": "application_" + "a" * 32}
RELEASES = "/home/user/OmegaDot/.runtime/omegacode/releases"
CODE_AGENT = "/home/user/Library/LaunchAgents/family.omegahive.omegacode.plist"


def intended_release():
    """The pinned Code release directory. Strict wherever Code releases live: OMEGACODE_RELEASES_DIR is set, or the
    default releases folder exists (the OmegaDot hosts); there a missing pinned release still fails (next7-r3). Only a
    machine with no Code releases folder at all (an outside checkout) skips, and says how to run the check."""
    import os
    import pathlib
    import pytest
    from hive.core.code import INTENDED_SERVICE_RELEASE
    root = os.environ.get("OMEGACODE_RELEASES_DIR")
    if root is None and not pathlib.Path(RELEASES).is_dir():
        pytest.skip(f"no OmegaCode releases on this machine ({RELEASES} absent); set OMEGACODE_RELEASES_DIR to a folder "
                    f"holding the pinned release {INTENDED_SERVICE_RELEASE[:8]} to run the route-table parity checks")
    return pathlib.Path(root or RELEASES) / INTENDED_SERVICE_RELEASE


def served_by_intended_release():
    """{(METHOD, template): sample path} for every handler in the pinned release's api.py."""
    release = intended_release()
    api = release / "omegacode" / "api.py"
    assert api.is_file(), f"intended service release not present: {release}"
    served = {}
    for method, template in re.findall(r"@app\.(get|post|put|delete)\(['\"]([^'\"]+)['\"]", api.read_text()):
        parts, out = template.strip("/").split("/"), []
        for i, part in enumerate(parts):
            out.append(SAMPLE.get(parts[i - 1], "x_a") if part.startswith("{") else part)
        served[(method.upper(), template)] = "/" + "/".join(out)
    return served


def test_every_relayed_route_exists_in_the_intended_service_release():
    """OmegaReview next7, Kimi next7-r3: route parity against the reviewed service's own handlers. A missing release
    fails rather than skips where Code releases live (see intended_release), an emptied parse fails, and the release is the one pinned beside the routes. The held
    copy-apply table is checked too: the pinned release (345fde53, routes as bdfb0591) serves it."""
    from hive.core.code import COPY_APPLY_ROUTES
    served = {(m, p) for (m, _), p in served_by_intended_release().items()}
    assert len(served) >= 50, f"only {len(served)} handlers parsed: the parse regressed"
    relayed = [(m, p) for m, p, _ in PROXY_ROUTES] + [(r["method"], r["pattern"]) for r in COPY_APPLY_ROUTES]
    missing = [(m, p) for m, p in relayed if not any(sm == m and re.fullmatch(p, sp) for sm, sp in served)]
    assert not missing, f"relayed but not served by the intended release: {missing}"


def test_every_route_the_intended_release_serves_is_relayed_held_or_declared_unrelayed():
    """bdfb0591 adoption, unchanged for 345fde53 (same api.py). Asserts, over the @app handlers parsed from the pinned
    release's api.py (the four default-off
    /v1/proposal-tests routes are mounted elsewhere and are not counted):
    1. exactly 72 (method, template) handlers are parsed;
    2. every UNRELAYED_SERVICE_ROUTES entry names one of those handlers (no stale entries);
    3. each handler's sample path matches exactly one of: a PROXY_ROUTES pattern, a COPY_APPLY_ROUTES pattern, or an
       UNRELAYED_SERVICE_ROUTES entry (never none, never two);
    4. sample paths for GET suggestion-scopes/scope_<32 hex>, POST proposal-test-receipts and GET
       proposal-test-receipts/ptr_a match no PROXY_ROUTES and no COPY_APPLY_ROUTES pattern (table membership only; this
       test does not call the relay, whose answer for an unmatched route is checked in the rollout smoke)."""
    from hive.core.code import COPY_APPLY_ROUTES, UNRELAYED_SERVICE_ROUTES
    served = served_by_intended_release()
    assert len(served) == 72, f"pinned release serves {len(served)} routes, expected 72"
    assert set(UNRELAYED_SERVICE_ROUTES) <= set(served), set(UNRELAYED_SERVICE_ROUTES) - set(served)
    for (method, template), path in served.items():
        kinds = [any(m == method and re.fullmatch(p, path) for m, p, _ in PROXY_ROUTES),
                 any(r["method"] == method and re.fullmatch(r["pattern"], path) for r in COPY_APPLY_ROUTES),
                 (method, template) in UNRELAYED_SERVICE_ROUTES]
        assert kinds.count(True) == 1, (method, template, kinds)
    for method, path in (("GET", "/v1/workspaces/ws_a/suggestion-scopes/scope_" + "a" * 32),
                         ("POST", "/v1/workspaces/ws_a/proposal-test-receipts"),
                         ("GET", "/v1/workspaces/ws_a/proposal-test-receipts/ptr_a")):
        assert not any(r[0] == method and re.fullmatch(r[1], path) for r in PROXY_ROUTES), path
        assert not any(r["method"] == method and re.fullmatch(r["pattern"], path) for r in COPY_APPLY_ROUTES), path


# api.py of bdfb0591, whose 72 routes the tables above were reviewed against. 345fde53 changes omegacode/runner.py only.
ROUTES_REVIEWED_API_PY_SHA256 = "b94ca80336556b4c206ddabad621ca670fb3f41de63f59c22825f609288febb6"


def test_the_pinned_release_serves_the_api_py_the_route_tables_were_reviewed_against():
    """345fde53 adoption: the pinned release's api.py is byte-identical to bdfb0591's, so the relay, held and unrelayed
    tables need no new route review. A release whose api.py differs fails here and needs its own route adoption."""
    import hashlib
    api = intended_release() / "omegacode" / "api.py"
    assert hashlib.sha256(api.read_bytes()).hexdigest() == ROUTES_REVIEWED_API_PY_SHA256, api


def test_the_relay_forwards_bdfb0591s_new_request_fields_unchanged():
    """bdfb0591's additive fields (retrieval corpus='text', completion preview profile) ride existing read routes; the
    relay enforces no body schema, so they reach the service byte for byte."""
    import asyncio
    from types import SimpleNamespace
    from hive.core.code import Code
    sent = []
    class Client:
        async def request(self, method, url, **kw):
            sent.append((method, url, kw["content"]))
            return SimpleNamespace(status_code=200, content=b"{}", headers={"content-type": "application/json"})
    code = Code.__new__(Code)
    code.client = Client()
    code.require_intended_release = lambda: None
    code._capability = lambda *a, **k: "t"
    code.hive = SimpleNamespace(settings=SimpleNamespace(copy_apply_claims=False),
                                services=SimpleNamespace(by_name=lambda n: {"address": "http://127.0.0.1:8724"}))
    bodies = {"/v1/workspaces/ws_a/repository-retrieval": {"corpus": "text", "query": "q"},
              "/v1/workspaces/ws_a/language/completion-previews": {"profile": "editor-snippet-template-v1", "items": []}}
    for path, body in bodies.items():
        raw = json.dumps(body).encode()
        status, _, _ = asyncio.run(code.proxy("user:operator", "POST", path, {}, raw, "g_a", None, "synthetic"))
        assert status == 200 and sent[-1] == ("POST", "http://127.0.0.1:8724" + path, raw)


def test_the_code_service_on_this_machine_loads_the_intended_release():
    """Kimi next7-r3: parity with a file on disk is only meaningful if the running service loads that file."""
    import pathlib
    import plistlib
    import pytest
    from hive.core.code import INTENDED_SERVICE_RELEASE
    agent = pathlib.Path(CODE_AGENT)
    if not agent.is_file():
        pytest.skip("no Code service LaunchAgent on this machine")
    path = plistlib.loads(agent.read_bytes()).get("EnvironmentVariables", {}).get("PYTHONPATH", "")
    assert f"/releases/{INTENDED_SERVICE_RELEASE}" in path, f"Code service loads {path!r}, not {INTENDED_SERVICE_RELEASE[:8]}"


def test_language_and_terminal_routes_carry_codes_actions():
    """Code host-next7-language-proxy: language inventory/query/preview read; applies/renames edit; terminal input run.
    Terminal-control status is read only. (It was held in error: the parity sample lacked tc_, Code 2026-10-05.)"""
    expect = {("GET", "/v1/workspaces/ws_a/language/servers"): {"read"}, ("POST", "/v1/workspaces/ws_a/language"): {"read"},
              ("POST", "/v1/workspaces/ws_a/language/completion-previews"): {"read"},
              ("POST", "/v1/workspaces/ws_a/language/completion-applies"): {"edit"},
              ("POST", "/v1/workspaces/ws_a/language/renames"): {"edit"},
              ("POST", "/v1/runs/run_a/terminal"): {"run"},
              ("GET", "/v1/runs/run_a/terminal/tc_a"): {"read"}}
    for (method, path), actions in expect.items():
        assert set(route_for(method, path)[2]) == actions, path


def test_the_proxy_matches_whole_paths_only():
    """Code 54fa42d3: a trailing newline or extra characters never reach an allowlisted route."""
    for method, path in (("GET", "/v1/workspaces/ws_a/files\n"), ("GET", "/v1/workspaces/ws_a/files/extra"),
                         ("GET", "/v1/capabilities\n")):
        assert not any(r[0] == method and re.fullmatch(r[1], path) for r in PROXY_ROUTES), repr(path)


def test_relayed_service_errors_use_the_hive_envelope_and_never_look_like_a_signout():
    """Surface 2026-10-05: one error shape for the UI, the service's code kept, and a service 401 relayed as 403."""
    from hive.core.code import relayed_error
    status, body, ctype = relayed_error(401, b'{"error": "invalid_capability", "message": "token revoked"}')
    error = json.loads(body)["error"]
    assert status == 403 and ctype == "application/json"
    assert error == {"code": "invalid_capability", "message": "token revoked", "source": "omegacode", "upstream_status": 401}
    status, body, _ = relayed_error(409, b'{"error": "stale", "message": "hunk moved", "current": 3}')
    assert status == 409 and json.loads(body)["error"]["current"] == 3 and json.loads(body)["error"]["code"] == "stale"
    status, body, _ = relayed_error(422, b'{"error": {"code": "bad_range", "message": "x"}}')
    assert json.loads(body)["error"]["code"] == "bad_range" and json.loads(body)["error"]["source"] == "omegacode"
    status, body, _ = relayed_error(500, b"<html>boom</html>")
    assert status == 500 and json.loads(body)["error"]["code"] == "service_error"


def test_merge_creation_needs_checkpoint_as_well_as_read():
    """Code CROSS_FORK_MERGE_PROXY_AUTHORITY_DIRECTION: a merge can capture another fork's checkpoint into custody."""
    routes = [r for r in PROXY_ROUTES if r[0] == "POST" and re.fullmatch(r[1], "/v1/workspaces/ws_a/merges")]
    assert len(routes) == 1 and set(routes[0][2]) == {"read", "checkpoint"}
    apply = [r for r in PROXY_ROUTES if r[0] == "POST" and re.fullmatch(r[1], "/v1/workspaces/ws_a/merges/merge_a/apply")]
    assert len(apply) == 1 and set(apply[0][2]) == {"read", "edit"}


def test_the_hive_refuses_to_relay_when_the_service_is_configured_for_another_release(tmp_path, monkeypatch):
    """Kimi next13 #4, OmegaReview next15 B1: the configured import of omegacode must be exactly the pinned release."""
    import asyncio
    import os
    import plistlib
    import time
    import pytest
    from hive.core.code import Code, CodeError, INTENDED_SERVICE_RELEASE
    releases = tmp_path / "releases"
    def release(name):
        (releases / name / "omegacode").mkdir(parents=True, exist_ok=True)
        (releases / name / "omegacode" / "__init__.py").write_text("")
        return str(releases / name)
    good, wrong, lookalike = release(INTENDED_SERVICE_RELEASE), release("0" * 64), release(INTENDED_SERVICE_RELEASE + "-evil")
    module_dir = tmp_path / "module-shadow"                            # Code's finding: a plain omegacode.py earlier on the path
    module_dir.mkdir()
    (module_dir / "omegacode.py").write_text("marker = 'WRONG'")
    namespace = tmp_path / "workdir"                                   # a namespace-only omegacode folder never wins
    (namespace / "omegacode").mkdir(parents=True)
    agent = tmp_path / "agent.plist"
    stamp = [time.time()]
    def configure(path):
        agent.write_bytes(plistlib.dumps({"EnvironmentVariables": {"PYTHONPATH": path}}))
        stamp[0] += 5
        os.utime(agent, (stamp[0], stamp[0]))                           # each change is re-read
    monkeypatch.setattr(Code, "CODE_AGENT_PLIST", str(agent))
    code = Code.__new__(Code)
    assert code._loaded_release_mismatch() is None                    # no LaunchAgent on this machine: nothing to check
    configure(good)
    assert code._loaded_release_mismatch() is None
    configure(f"{namespace}:{good}")
    assert code._loaded_release_mismatch() is None                    # namespace portion + the real package is fine
    for bad in (wrong, f"{wrong}:{good}", f"{good}:{wrong}", lookalike, str(tmp_path / "empty"),
                f"{module_dir}:{good}", f"{good}:{module_dir}"):
        configure(bad)
        assert code._loaded_release_mismatch() is not None, bad       # wrong, shadowed, ambiguous, lookalike, missing
    configure(wrong)
    with pytest.raises(CodeError) as e:
        asyncio.run(code.proxy("user:operator", "GET", "/v1/health", {}, b"", "g_a", None, "synthetic"))
    assert e.value.status == 503 and e.value.code == "service_release_mismatch"
    # relative and empty entries resolve against the service's directory, not ours: refused (OmegaReview next15 B1)
    for bad in (f"relative-imports:{good}", f":{good}", f"{good}:"):
        configure(bad)
        assert code._loaded_release_mismatch() == "relative or empty entry on the configured path", bad
    def configure_m(workdir):
        agent.write_bytes(plistlib.dumps({"ProgramArguments": ["python", "-m", "omegacode"],
                                          **({"WorkingDirectory": workdir} if workdir is not None else {}),
                                          "EnvironmentVariables": {"PYTHONPATH": good}}))
        stamp[0] += 5
        os.utime(agent, (stamp[0], stamp[0]))
    configure_m("relative/dir")
    assert code._loaded_release_mismatch() == "no absolute working directory for a -m service"
    configure_m(None)
    assert code._loaded_release_mismatch() == "no absolute working directory for a -m service"
    shadow_wd = tmp_path / "service-wd"                                # -m searches the working directory first
    shadow_wd.mkdir()
    (shadow_wd / "omegacode.py").write_text("marker = 'WRONG'")
    configure_m(str(shadow_wd))
    assert code._loaded_release_mismatch() is not None
    configure_m(str(namespace))
    assert code._loaded_release_mismatch() is None
    # symlinks are judged on what they resolve to (Kimi next15-r2)
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "omegacode").mkdir(parents=True)
    (elsewhere / "omegacode" / "__init__.py").write_text("marker = 'ELSEWHERE'")
    linked_root = tmp_path / "linked" / "releases"
    linked_root.mkdir(parents=True)
    (linked_root / INTENDED_SERVICE_RELEASE).symlink_to(elsewhere, target_is_directory=True)
    configure(str(linked_root / INTENDED_SERVICE_RELEASE))
    assert code._loaded_release_mismatch() is not None
    agent.write_bytes(b"not a plist")
    stamp[0] += 5
    os.utime(agent, (stamp[0], stamp[0]))
    assert code._loaded_release_mismatch() == "agent unreadable"       # fails closed


def test_merge_review_is_relayed_read_only():
    """Code CANVAS_P1 owner ruling item 3: GET merge-review is a read relay (the service itself needs full-workspace
    read scope); no other method reaches it."""
    assert set(route_for("GET", "/v1/workspaces/ws_a/merge-review/ch_1")[2]) == {"read"}
    for method in ("POST", "PUT", "DELETE"):
        assert not any(r[0] == method and re.fullmatch(r[1], "/v1/workspaces/ws_a/merge-review/ch_1") for r in PROXY_ROUTES)


def test_merge_review_forwards_only_verification_ids_and_keeps_every_one():
    """Code MERGE_REVIEW_QUERY_OWNER_RULING: only verification_id, repeatable, at most 100 unique, 1-160 characters;
    every value is forwarded (never last-one-wins); any other key is refused, not silently passed or dropped."""
    import pytest
    from hive.core.code import CodeError, checked_query
    pattern = route_for("GET", "/v1/workspaces/ws_a/merge-review/ch_1")[1]
    pairs = [("verification_id", "v1"), ("verification_id", "v2")]
    assert checked_query(pattern, pairs) == pairs
    assert checked_query(pattern, []) == []
    for bad in ([("verification_id", "v1"), ("approve", "1")], [("verification_id", "")],
                [("verification_id", "x" * 161)], [("verification_id", "v1"), ("verification_id", "v1")],
                [("verification_id", f"v{i}") for i in range(101)]):
        with pytest.raises(CodeError) as err:
            checked_query(pattern, bad)
        assert err.value.status == 400, bad


def test_routes_without_a_query_rule_keep_one_value_per_key():
    """Unlisted routes behave exactly as before r11 (one value per key, the last), until Code rules on them."""
    from hive.core.code import checked_query
    pattern = route_for("GET", "/v1/workspaces/ws_a/files")[1]
    assert checked_query(pattern, [("path", "a"), ("path", "b"), ("after", "2")]) == {"path": "b", "after": "2"}
    assert checked_query(pattern, {"path": "a"}) == {"path": "a"}


def test_every_query_rule_names_a_relayed_route():
    """Kimi r11 finding 3: a rule keyed by a pattern that is not exactly a PROXY_ROUTES pattern would never apply."""
    from hive.core.code import QUERY_RULES
    assert set(QUERY_RULES) <= {r[1] for r in PROXY_ROUTES}
