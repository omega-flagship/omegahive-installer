"""Each relayed OmegaCode route gets exactly its minimal actions (Code PROXY_ACTIONS_RESPONSE, Kimi 2026-10-05)."""
import json
import os
import pathlib
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
    """Served by the pinned service (93e49926 onward); adopted with exactly the actions in RUN_RESULT_PROXY_ROUTE_DIRECTION.json."""
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
RELEASES = os.path.join(os.path.expanduser("~"), "OmegaDot", ".runtime", "omegacode", "releases")
CODE_AGENT = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", "family.omegahive.omegacode.plist")


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


# Conditional route Source belongs to the exact reviewed service97 composition.
# This inventory proves support only under the selector and successful original
# startup/lifespan below; it never reports a live mount or changes configuration.
SANDBOX_RESULTS_INSTALLER_SOURCE_SHA256 = {'__main__.py': '1bbc43c992e316eab93d59432cf387b998bb3047e24ad68feaccabf6a059b35e', 'purpose_startup.py': 'faeae9cce8ef143ae621e8ecd8669970d55cc35fefdd5a5e7aba629cf376d061', 'proposal_tests/sandbox_api.py': '87783893ebda78a6ec835443d09d8457d6723a72c3c7e3d66899dee372265482', 'proposal_tests/sandbox_results_api.py': '66068cf54e7291815d825b6df65af152a170604641eb86342d5456100f8c66be'}


def conditionally_served_sandbox_results_by_intended_release():
    """One Source route under exclusive sandbox selection, not a live-route probe."""
    import ast
    import hashlib
    release = intended_release()  # retains strict missing-release behavior
    trees = {}
    for relative, expected in SANDBOX_RESULTS_INSTALLER_SOURCE_SHA256.items():
        path = release / "omegacode" / relative
        assert path.is_file(), f"reviewed sandbox installer Source absent: {path}"
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == expected, path
        trees[relative] = ast.parse(raw)

    def function(tree, name):
        matches = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name]
        assert len(matches) == 1, name
        return matches[0]

    def named_calls(tree, name):
        return [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name]

    # Derive the actual configuration selectors/defaults from the entrypoint;
    # no live config/token file is opened and no selector is enabled by this test.
    entry = named_calls(function(trees["__main__.py"], "main"), "create_purpose_app")
    assert len(entry) == 1
    selectors = {}
    for keyword in entry[0].keywords:
        if keyword.arg in ("enabled", "sandbox_enabled"):
            value = keyword.value
            assert (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                    and isinstance(value.func.value, ast.Name) and value.func.value.id == "config"
                    and value.func.attr == "get" and len(value.args) == 2 and not value.keywords)
            selectors[keyword.arg] = (ast.literal_eval(value.args[0]), ast.literal_eval(value.args[1]))
    assert selectors == {"enabled": ("proposal_tests_enabled", False),
                         "sandbox_enabled": ("sandbox_project_tests_enabled", False)}

    factory = function(trees["purpose_startup.py"], "create_purpose_app")
    lifespan = function(factory, "lifespan")
    branches = [n for n in lifespan.body if isinstance(n, ast.Try)
                for n in n.body if isinstance(n, ast.If) and isinstance(n.test, ast.Name)
                and n.test.id == "sandbox_enabled"]
    assert len(branches) == 1
    branch = branches[0]
    assert any(isinstance(n, ast.ImportFrom) and n.level == 1 and n.module == "proposal_tests.sandbox_api"
               and any(a.name == "install" and a.asname == "sandbox_install" for a in n.names) for n in branch.body)
    install = named_calls(branch, "sandbox_install")
    assert len(install) == 1
    assert [n.id for n in install[0].args] == ["app", "service", "authority", "host"]
    assert len(install[0].keywords) == 1 and install[0].keywords[0].arg == "enabled"
    assert ast.literal_eval(install[0].keywords[0].value) is True

    sandbox = function(trees["proposal_tests/sandbox_api.py"], "install")
    assert any(isinstance(n, ast.ImportFrom) and n.level == 1 and n.module == "sandbox_results_api"
               and any(a.name == "install" and a.asname == "results_install" for a in n.names) for n in sandbox.body)
    results_call = named_calls(sandbox, "results_install")
    assert len(results_call) == 1 and not results_call[0].keywords
    assert [n.id for n in results_call[0].args] == ["app", "service", "host"]
    results = function(trees["proposal_tests/sandbox_results_api.py"], "install")
    declarations = [d for n in results.body if isinstance(n, ast.FunctionDef)
                    for d in n.decorator_list if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                    and isinstance(d.func.value, ast.Name) and d.func.value.id == "router"]
    assert len(declarations) == 1
    declaration = declarations[0]
    assert declaration.func.attr == "get" and len(declaration.args) == 1 and not declaration.keywords
    template = ast.literal_eval(declaration.args[0])
    assert type(template) is str
    assert any(isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
               and isinstance(n.value.func, ast.Attribute) and isinstance(n.value.func.value, ast.Name)
               and n.value.func.value.id == "app" and n.value.func.attr == "include_router"
               and len(n.value.args) == 1 and isinstance(n.value.args[0], ast.Name)
               and n.value.args[0].id == "router" and not n.value.keywords for n in results.body)
    parts = template.strip("/").split("/")
    path = "/" + "/".join(SAMPLE.get(parts[i - 1], "x_a") if part.startswith("{") else part
                          for i, part in enumerate(parts))
    scope = {"sandbox_project_tests_enabled": True, "proposal_tests_enabled": False,
             "requires_successful_same_owner_proposal_only_startup_and_lifespan": True,
             "live_mount_verified": False}
    return {("GET", template): path}, scope


def test_every_relayed_route_exists_in_the_intended_service_release():
    """OmegaReview next7, Kimi next7-r3: route parity against the reviewed service's own handlers. A missing release
    fails rather than skips where Code releases live (see intended_release), an emptied parse fails, and the release is the one pinned beside the routes. The held
    copy-apply table is checked too: the pinned release (345fde53, routes as bdfb0591) serves it."""
    from hive.core.code import COPY_APPLY_ROUTES
    served = {(m, p) for (m, _), p in served_by_intended_release().items()}
    assert len(served) >= 50, f"only {len(served)} handlers parsed: the parse regressed"
    conditional, installation_scope = conditionally_served_sandbox_results_by_intended_release()
    assert installation_scope == {"sandbox_project_tests_enabled": True, "proposal_tests_enabled": False,
                                  "requires_successful_same_owner_proposal_only_startup_and_lifespan": True,
                                  "live_mount_verified": False}
    # Source parity includes this exact supported conditional route. Actual live
    # mount/loaded-process acceptance still needs the owner's selected startup.
    served.update((m, p) for (m, _), p in conditional.items())
    relayed = [(m, p) for m, p, _ in PROXY_ROUTES] + [(r["method"], r["pattern"]) for r in COPY_APPLY_ROUTES]
    missing = [(m, p) for m, p in relayed if not any(sm == m and re.fullmatch(p, sp) for sm, sp in served)]
    assert not missing, f"relayed but not served by the intended release: {missing}"


def test_every_route_the_intended_release_serves_is_relayed_held_or_declared_unrelayed():
    """bdfb0591 adoption, unchanged for 345fde53 (same api.py). Asserts, over the @app handlers parsed from the pinned
    release's api.py (the four default-off
    /v1/proposal-tests routes are mounted elsewhere and are not counted):
    1. exactly 74 (method, template) handlers are parsed;
    2. every UNRELAYED_SERVICE_ROUTES entry names one of those handlers (no stale entries);
    3. each handler's sample path matches exactly one of: a PROXY_ROUTES pattern, a COPY_APPLY_ROUTES pattern, or an
       UNRELAYED_SERVICE_ROUTES entry (never none, never two);
    4. sample paths for GET suggestion-scopes/scope_<32 hex>, POST proposal-test-receipts and GET
       proposal-test-receipts/ptr_a match no PROXY_ROUTES and no COPY_APPLY_ROUTES pattern (table membership only; this
       test does not call the relay, whose answer for an unmatched route is checked in the rollout smoke)."""
    from hive.core.code import COPY_APPLY_ROUTES, UNRELAYED_SERVICE_ROUTES
    served = served_by_intended_release()
    assert len(served) == 74, f"pinned release serves {len(served)} routes, expected 74"
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


# Exact service97 API: the same 74 direct handlers, with the reviewed execution_policy
# response field and runtime-probes guard. The conditional sandbox GET is inventoried
# separately above. Any other API byte change requires a new coupled review.
ROUTES_REVIEWED_API_PY_SHA256 = "19e9032f8fa2cf69e1b4c5433194a1ee7059aea7b6d0ba7b9749d8bf7a116347"


def test_the_pinned_release_serves_the_api_py_the_route_tables_were_reviewed_against():
    """C2 R10 adoption: the pinned release's api.py is the reviewed one; its route set equals bdfb0591's, so the relay,
    held and unrelayed tables need no new route review. A release whose api.py differs fails here."""
    import hashlib
    api = intended_release() / "omegacode" / "api.py"
    assert hashlib.sha256(api.read_bytes()).hexdigest() == ROUTES_REVIEWED_API_PY_SHA256, api


def test_the_relay_forwards_bdfb0591s_new_request_fields_unchanged(monkeypatch):
    """bdfb0591's additive fields (retrieval corpus='text', completion preview profile) ride existing read routes; the
    relay enforces no body schema, so they reach the service byte for byte."""
    import asyncio
    from types import SimpleNamespace
    import hive.core.code as code_module
    from hive.core.code import Code
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset())   # body forwarding only; relay path: test_relay_proof
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


def linux_unit(tmp_path, monkeypatch):
    import os
    """A synthetic Linux Code user unit: systemd's view, the main process's /proc view and /proc/net/tcp."""
    from hive.core.code import Code, INTENDED_SERVICE_RELEASE
    release = tmp_path / "releases" / INTENDED_SERVICE_RELEASE
    (release / "omegacode").mkdir(parents=True)
    (release / "omegacode" / "__init__.py").write_text("")
    workdir = tmp_path / "work"; workdir.mkdir(); workdir.chmod(0o700)
    config = tmp_path / "config.json"; config.write_text('{"port": 8724, "operator_token_file": "/never/read"}')
    python = "/opt/code/python/bin/python3.12"
    from types import SimpleNamespace
    argv = [python, "-B", "-s", "-m", "omegacode", "--config", str(config)]
    monkeypatch.setattr(Code, "_code_python", staticmethod(lambda: python))
    world = {
        "show": {"LoadState": "loaded", "ActiveState": "active", "MainPID": "4242",
                 "ExecStart": "{ path=%s ; argv[]=%s ; ignore_errors=no ; start_time=[n/a] ; pid=4242 ; code=(null) }"
                              % (python, " ".join(argv)),
                 "WorkingDirectory": str(workdir), "Environment": f"PYTHONPATH={release}"},
        "status": f"Name:\tpython3.12\nUid:\t{os.getuid()}\t{os.getuid()}\n".encode(),
        "cmdline": b"\0".join(a.encode() for a in argv) + b"\0",
        "environ": f"PYTHONPATH={release}\0HOME=/home/x\0".encode(),
        "cwd": str(workdir),
        "exe": python,
        "stat": b"4242 (python3.12) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 3 0 777001 1000 100 0 0",
        "address": "http://127.0.0.1:8724",
        "fds": {"3": "socket:[555]", "4": "/dev/null"},
        "tcp": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
               f"   0: 0100007F:2214 00000000:0000 0A 00000000:00000000 00:00000000 00000000 {os.getuid()} 0 555 1 0\n",
        "tcp6": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
    }
    def read_proc(pid, name):
        if pid == "self":
            return world[name.split("/")[1]].encode()
        return world[name] if isinstance(world[name], bytes) else world[name].encode()
    monkeypatch.setattr(Code, "_read_proc", staticmethod(read_proc))
    monkeypatch.setattr(Code, "_proc_link", staticmethod(lambda pid, name: world[name] if name in ("cwd", "exe")
                                                          else world["fds"][name.split("/")[1]]))
    monkeypatch.setattr(Code, "_module_digest", staticmethod(
        lambda package: INTENDED_SERVICE_RELEASE if package.parent.name == INTENDED_SERVICE_RELEASE else "0" * 64))
    monkeypatch.setattr(Code, "_proc_fds", staticmethod(lambda pid: list(world["fds"])))
    monkeypatch.setattr(Code, "_systemd_show", staticmethod(lambda unit: world["show"]))
    code = Code.__new__(Code)
    code.hive = SimpleNamespace(services=SimpleNamespace(
        by_name=lambda name: {"address": world["address"]} if world["address"] else None))
    return code, world, release, workdir


def test_linux_release_guard_passes_only_the_reviewed_unit_and_its_own_listener(tmp_path, monkeypatch):
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    assert code._linux_release_facts_problem(world["show"]) is None


def test_linux_release_guard_fails_closed(tmp_path, monkeypatch):
    import copy
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    base = copy.deepcopy(world)
    wrong = tmp_path / "releases" / ("0" * 64); (wrong / "omegacode").mkdir(parents=True)
    (wrong / "omegacode" / "__init__.py").write_text("")
    cases = {
        "no unit": lambda w: w["show"].update(LoadState="not-found"),
        "not running": lambda w: w["show"].update(ActiveState="inactive"),
        "no pid": lambda w: w["show"].update(MainPID="0"),
        "shell wrapper": lambda w: w["show"].update(ExecStart="{ path=/bin/sh ; argv[]=/bin/sh -c x ; ignore_errors=no }"),
        "isolated mode": lambda w: w["show"].update(ExecStart=w["show"]["ExecStart"].replace(" -B ", " -I ")),
        "user site allowed": lambda w: w["show"].update(ExecStart=w["show"]["ExecStart"].replace(" -s ", " ")),
        "unpinned interpreter": lambda w: w["show"].update(ExecStart=w["show"]["ExecStart"].replace(
            "/opt/code/python/bin/python3.12", "/opt/code/other/python3")),
        "wrong release": lambda w: w["show"].update(Environment=f"PYTHONPATH={wrong}"),
        "no path": lambda w: w["show"].update(Environment=""),
        "extra path entry": lambda w: w["show"].update(Environment=w["show"]["Environment"] + ":/tmp/sitecustomize-dir"),
        "preload": lambda w: w["show"].update(Environment=w["show"]["Environment"] + " LD_PRELOAD=/x.so"),
        "other account": lambda w: w.update(status=b"Uid:\t0\t0\n"),
        "argv differs": lambda w: w.update(cmdline=w["cmdline"].replace(b"-B", b"-X")),
        "cwd differs": lambda w: w.update(cwd=str(tmp_path)),
        "path differs at runtime": lambda w: w.update(environ=f"PYTHONPATH={wrong}\0".encode()),
        "preload at runtime": lambda w: w.update(environ=w["environ"] + b"LD_PRELOAD=/x.so\0"),
        "all interfaces": lambda w: w.update(tcp=w["tcp"].replace("0100007F:2214", "00000000:2214")),
        "second listener": lambda w: w.update(tcp6=w["tcp6"] + "   0: 00000000000000000000000000000000:2214 "
                                              "00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 777 1 0\n"),
        "no listener": lambda w: w.update(tcp=w["tcp"].splitlines()[0] + "\n"),
        "held by another process": lambda w: w.update(fds={"3": "socket:[999]"}),
        "relay goes elsewhere": lambda w: w.update(address="http://127.0.0.1:9999"),
        "not registered": lambda w: w.update(address=None),
        "another interpreter": lambda w: w.update(exe="/usr/bin/python3"),
    }
    for name, change in cases.items():
        world.clear(); world.update(copy.deepcopy(base))
        change(world)
        assert code._linux_release_facts_problem(world["show"]) is not None, name
    world.clear(); world.update(copy.deepcopy(base))
    (workdir / "omegacode.py").write_text("shadow = True")               # a file in the working directory
    assert code._linux_release_facts_problem(world["show"]) is not None
    (workdir / "omegacode.py").unlink(); workdir.chmod(0o755)              # not private
    assert code._linux_release_facts_problem(world["show"]) is not None


def test_linux_release_guard_is_used_on_linux_and_unreadable_facts_refuse(monkeypatch):
    import hive.core.code as module
    from hive.core.code import Code
    monkeypatch.setattr(module.sys, "platform", "linux")
    monkeypatch.setattr(Code, "_systemd_show", staticmethod(lambda unit: (_ for _ in ()).throw(OSError("no bus"))))
    code = Code.__new__(Code)
    assert code._loaded_release_mismatch() == "Code service facts unreadable (OSError)"


def test_linux_release_guard_checks_release_contents_and_process_instance(tmp_path, monkeypatch):
    from hive.core.code import Code, INTENDED_SERVICE_RELEASE
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    monkeypatch.setattr(Code, "_module_digest", staticmethod(lambda package: "f" * 64))   # right name, wrong contents
    assert code._linux_release_facts_problem(world["show"]) == "the Code release contents do not match the pin"
    code, world, release, workdir = linux_unit(tmp_path / "b", monkeypatch)
    starts = iter([b"1 (p) S" + b" 0" * 18 + b" 100", b"1 (p) S" + b" 0" * 18 + b" 200"])
    original = Code._read_proc
    monkeypatch.setattr(Code, "_read_proc", staticmethod(
        lambda pid, name: next(starts) if name == "stat" else original(pid, name)))
    assert code._linux_release_facts_problem(world["show"]) == "the Code service restarted during the check"


def test_module_digest_matches_codes_recipe(tmp_path):
    import hashlib
    from hive.core.code import Code
    pkg = tmp_path / "omegacode"; (pkg / "sub").mkdir(parents=True)
    (pkg / "__init__.py").write_text("a"); (pkg / "sub" / "x.py").write_text("b")
    (pkg / "__pycache__").mkdir(); (pkg / "__pycache__" / "y.py").write_text("ignored")
    h = hashlib.sha256()
    for rel, body in sorted([("__init__.py", b"a"), ("sub/x.py", b"b")]):
        h.update(rel.encode() + b"\0" + hashlib.sha256(body).hexdigest().encode() + b"\n")
    assert Code._module_digest(pkg) == h.hexdigest()


def test_linux_release_guard_never_reuses_a_pass(monkeypatch):
    from hive.core.code import Code
    calls = []
    monkeypatch.setattr(Code, "_systemd_show", staticmethod(lambda unit: calls.append(1) or {}))
    monkeypatch.setattr(Code, "_linux_release_facts_problem", lambda self, show: None)
    code = Code.__new__(Code)
    code._linux_release_problem(); code._linux_release_problem()
    assert len(calls) == 2


def test_linux_release_guard_reads_only_a_private_regular_config(tmp_path, monkeypatch):
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    config = pathlib.Path(world["show"]["ExecStart"].split("--config ")[1].split()[0])
    target = tmp_path / "elsewhere.json"; target.write_text(config.read_text())
    def refused():                                   # a refusal, or an error the outer guard turns into one
        try:
            return code._linux_release_facts_problem(world["show"]) is not None
        except OSError:
            return True
    config.unlink(); config.symlink_to(target)
    assert refused()                                                              # a link is refused (no follow)
    config.unlink(); os.mkfifo(config)
    assert refused()                                                              # a FIFO never blocks the hive


def test_linux_release_guard_rechecks_the_main_process_at_the_end(tmp_path, monkeypatch):
    from hive.core.code import Code
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    shows = iter([dict(world["show"], MainPID="5555")])
    monkeypatch.setattr(Code, "_systemd_show", staticmethod(lambda unit: next(shows)))
    assert code._linux_release_facts_problem(world["show"]) == "the Code service restarted during the check"


def test_wrong_service_release_refuses_before_relay_despite_proof_allowset(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import pytest
    from hive.core import code as module
    from hive.core.code import CodeError, INTENDED_SERVICE_RELEASE
    code, world, release, workdir = linux_unit(tmp_path, monkeypatch)
    assert code._linux_release_facts_problem(world["show"]) is None
    assert INTENDED_SERVICE_RELEASE in module.RELAY_PROOF_RELEASES
    assert "309df6d5c9c35427c53e7b6525e1be2729c95d04cbab6057207071c82f3fdbfe" in module.RELAY_PROOF_RELEASES
    wrong = tmp_path / "releases" / "309df6d5c9c35427c53e7b6525e1be2729c95d04cbab6057207071c82f3fdbfe"
    (wrong / "omegacode").mkdir(parents=True)
    (wrong / "omegacode" / "__init__.py").write_text("")
    world["show"]["Environment"] = f"PYTHONPATH={wrong}"
    # Target-local platform selection; the shared sys module is untouched.
    monkeypatch.setattr(module, "sys", SimpleNamespace(platform="linux"))
    forwarded = []
    async def denied_forward(*args, **kwargs):
        forwarded.append((args, kwargs))
        raise AssertionError("wrong service must refuse before forwarding")
    monkeypatch.setattr(module, "proved_request", denied_forward)
    code.client = SimpleNamespace(request=denied_forward)
    with pytest.raises(CodeError) as failure:
        code.require_intended_release()
    assert failure.value.status == 503 and failure.value.code == "service_release_mismatch"
    with pytest.raises(CodeError) as failure:
        asyncio.run(code.relay_agent("synthetic-member", "hc1.synthetic", "GET", "/v1/health", "", b""))
    assert failure.value.status == 503 and failure.value.code == "service_release_mismatch"
    assert forwarded == []


def test_owner_local_enrolment_pins_only_its_reviewed_release(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from hive.core.code import Code, INTENDED_SERVICE_RELEASE, LOCAL_ENROLMENT_SERVICE_RELEASE, RELAY_PROOF_RELEASES
    from hive.core.code_local_enrolment import ENV_SOCKET

    monkeypatch.delenv(ENV_SOCKET, raising=False)
    monkeypatch.delenv("HIVE_CODE_SERVICE_CONFIG", raising=False)
    hive = SimpleNamespace(settings=SimpleNamespace(core_root=tmp_path))
    default = Code(hive, None)
    monkeypatch.setenv(ENV_SOCKET, str(tmp_path / "code-enrol.sock"))
    local = Code(hive, None)
    assert default.intended_service_release == INTENDED_SERVICE_RELEASE
    assert local.intended_service_release == LOCAL_ENROLMENT_SERVICE_RELEASE
    assert {INTENDED_SERVICE_RELEASE, LOCAL_ENROLMENT_SERVICE_RELEASE} <= RELAY_PROOF_RELEASES

    from hive.core import code as code_module
    monkeypatch.setattr(code_module, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(Code, "CODE_AGENT_PLIST", str(tmp_path / "absent.plist"))
    assert default._loaded_release_mismatch() is None
    assert local._loaded_release_mismatch() == "the owner-local Code LaunchAgent is absent"

    paths = {}
    for release in (default.intended_service_release, local.intended_service_release):
        path = tmp_path / "releases" / release / "omegacode"
        path.mkdir(parents=True)
        (path / "__init__.py").write_text("")
        paths[release] = str(path.parent)
    for instance in (default, local):
        for release, path in paths.items():
            problem = instance._path_release_problem([path], [], None, instance.intended_service_release)
            assert (problem is None) == (release == instance.intended_service_release)
