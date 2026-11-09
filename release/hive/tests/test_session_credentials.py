"""Sessions reconnect themselves (credentials.py, session_launch.py; session onboarding DESIGN_R2 §R/§S/§U/§W/§X/§Z).

Synthetic hives only. No real credential is read, printed or moved: every token here is minted by the test hive."""

import io
import json
import os
import pathlib
import re
import types

import pytest

from hive.core import credentials as cr
from hive.core import session_launch as sl
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_repo_map import SYNTHETIC
from hive.tests.test_visibility import person

SETTINGS = types.SimpleNamespace(public_url="http://127.0.0.1:8700")
BINDING = "0b5e5510-aaaa-4bbb-8ccc-000000000001"


def bridge(c, mind="Dot", binding=BINDING, **extra):
    reply = sl.answer(c.app.state.hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": binding,
                                                   "mind": mind, **extra})
    assert reply["status"] == "issued", reply
    return reply


def rpc(c, token, method, params=None):
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, **({"params": params} if params else {})},
                  headers={"Authorization": f"Bearer {token}"})


def tool(c, token, name, args=None):
    r = rpc(c, token, "tools/call", {"name": name, "arguments": args or {}})
    if r.status_code != 200:
        return r.status_code, None
    body = r.json()
    if "error" in body:
        return body["error"]["data"]["code"], None
    return None, body["result"]["structuredContent"]


def rows(hive, table):
    return hive.db.one(f"SELECT COUNT(*) n FROM {table}")["n"]


def test_the_exception_list_is_exactly_dot_and_surface():
    assert cr.BRIDGE_EXCEPTION == ("Dot", "Surface")
    assert cr.MIXED_CONTEXT_READS <= {"hive_whoami", "hive_capabilities", "hive_inbox", "hive_goals", "hive_goal_get",
                                      "hive_motivations", "hive_query", "hive_evidence_query", "hive_repo_query",
                                      "hive_artifact_read", "hive_revision_read", "hive_exhibit_read"}   # never wider than §P


def test_a_pending_credential_opens_only_whoami_then_reads_work(client):
    hive = client.app.state.hive
    reply = bridge(client)
    token = reply["token"]
    assert reply["name"] == "Dot" and reply["credential"]["status"] == "pending" and reply["credential"]["mixed_context"]
    assert reply["mcp_url"] == "http://127.0.0.1:8700/mcp"
    stored = hive.db.one("SELECT * FROM agent_credentials")
    assert token not in json.dumps(stored) and stored["token_hash"] != token          # only the hash is kept
    listed = [t["name"] for t in rpc(client, token, "tools/list").json()["result"]["tools"]]
    assert listed == ["hive_whoami"]
    assert tool(client, token, "hive_inbox") == ("credential_pending", None)
    assert tool(client, token, "hive_repo_query", {"view": "maps"}) == ("credential_pending", None)
    err, me = tool(client, token, "hive_whoami")
    assert err is None and me["name"] == "Dot"
    assert hive.db.one("SELECT status FROM agent_credentials")["status"] == "active"
    assert tool(client, token, "hive_inbox") == (None, {"messages": []})
    assert client.post("/api/admin/repo-maps", json=SYNTHETIC).status_code == 200
    err, maps = tool(client, token, "hive_repo_query", {"view": "maps"})
    assert err is None and [m["repo"] for m in maps["maps"]] == ["fixture-mini"]       # the repo maps are back
    listed = {t["name"] for t in rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert listed == cr.MIXED_CONTEXT_READS | {cr.MIGRATION_TOOL}


def test_a_mixed_context_bridge_submits_nothing(client):
    hive = client.app.state.hive
    token = bridge(client)["token"]
    tool(client, token, "hive_whoami")
    before = [rows(hive, t) for t in ("messages", "goals", "approvals")]
    for name, args in (("hive_send", {"text": "private words"}), ("hive_goal_create", {"title": "private words"}),
                       ("hive_publish", {"statement": "(private words)", "f": 1.0, "c": 0.9}),
                       ("hive_query", {"pattern": "(private words)"}), ("hive_goal_result", {}),
                       ("hive_request", {}), ("hive_code_mind_proof", {})):
        assert tool(client, token, name, args) == ("mixed_context_refused", None), name
    assert [rows(hive, t) for t in ("messages", "goals", "approvals")] == before


def test_an_ask_rule_refuses_a_read_without_storing_anything(client):
    hive = client.app.state.hive
    token = bridge(client)["token"]
    tool(client, token, "hive_whoami")
    agent_id = hive.db.one("SELECT agent_id FROM agent_credentials")["agent_id"]
    hive.policy.add_rule(f"agent:{agent_id}", "repo-query", "ask", "synthetic")
    approvals = rows(hive, "approvals")
    err, _ = tool(client, token, "hive_repo_query", {"view": "nodes", "repo": "private-words", "sha": "abcdef1", "q": "private"})
    assert err == "approval_unavailable"
    assert rows(hive, "approvals") == approvals and not hive.policy.recent.get(agent_id)
    hive.policy.add_rule(f"agent:{agent_id}", "repo-query", "deny", "synthetic")
    assert tool(client, token, "hive_repo_query", {"view": "maps"})[0] == "policy_denied"


def _agent_routes(app):
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None or route.path == "/mcp":
            continue
        yield route   # W-b: every route, websockets included


def test_every_other_surface_refuses_a_restricted_credential(client):
    """W-a/W-b/W-c: every route that takes an agent token refuses a pending or mixed-context credential with 403."""
    hive = client.app.state.hive
    for activate in (False, True):
        token = bridge(client, replace=True)["token"]
        if activate:
            tool(client, token, "hive_whoami")
        before = [rows(hive, t) for t in ("messages", "goals", "approvals")]
        checked = 0
        for route in _agent_routes(client.app):
            path = re.sub(r"\{[^}]+\}", "x", route.path)
            if not hasattr(route, "methods"):    # websockets: /agent-hub is refused before admission
                from starlette.websockets import WebSocketDisconnect
                with pytest.raises(WebSocketDisconnect) as closed:
                    with client.websocket_connect(path, headers={"Authorization": f"Bearer {token}"}) as ws:
                        ws.receive_text()
                assert closed.value.code == 4403, route.path
                checked += 1
                continue
            method = sorted(route.methods - {"HEAD"})[0]
            headers = {"Authorization": f"Bearer {token}", "X-Hive-Token": token}
            r = client.request(method, path, headers=headers, json={})
            assert r.status_code == 403 and r.json()["error"]["code"] == "credential_surface_refused", (route.path, r.status_code, r.text[:200])
            checked += 1
        assert checked >= 300
        assert [rows(hive, t) for t in ("messages", "goals", "approvals")] == before


def test_the_authentication_call_itself_refuses_with_a_closed_default(client):
    """The second layer behind the middleware: Hive.authenticate_agent raises 403 (never None) off /mcp."""
    from hive.core.hive import HiveError
    hive = client.app.state.hive
    token = bridge(client)["token"]
    for surface in (None, "rest", "agent-hub", "code-relay", "code-mind-proof", "llm"):
        with pytest.raises(HiveError) as refused:
            hive.authenticate_agent(token, surface=surface)
        assert refused.value.status == 403 and refused.value.code == "credential_surface_refused"
    assert hive.authenticate_agent(token, surface="mcp")["name"] == "Dot"
    assert hive.authenticate_agent("ohb1_" + "x" * 43, surface="rest") is None


def test_every_authentication_call_site_names_its_surface():
    """W-e: the 12 production call sites, each with an explicit surface; a new one fails here until reviewed."""
    root = pathlib.Path(cr.__file__).resolve().parent
    sites = []
    for path in sorted(root.glob("*.py")):
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if "authenticate_agent(" in line and "def authenticate_agent" not in line:
                sites.append((path.name, line.strip()))
    assert len(sites) == 12, sites
    assert all("surface=" in line for _, line in sites), sites
    assert sorted(re.search(r'surface="([a-z-]+)"', line).group(1) for _, line in sites) == sorted(
        ["rest"] * 5 + ["mcp"] * 4 + ["code-relay", "agent-hub", "code-mind-proof"])
    mcp_files = {f for f, line in sites if 'surface="mcp"' in line}
    assert mcp_files == {"mcp.py", "app.py"}


def test_fencing_disconnect_and_one_credential_per_mind(client):
    hive = client.app.state.hive
    first = bridge(client)["token"]
    tool(client, first, "hive_whoami")
    refused = sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "mind": "Dot",
                                         "binding": "0b5e5510-aaaa-4bbb-8ccc-000000000002"})
    assert refused == {"status": "refused", "code": "already_bridged"}
    again = bridge(client)["token"]                    # the same session relaunched: its own old credential ends
    assert tool(client, first, "hive_whoami")[0] == 401
    assert tool(client, again, "hive_whoami")[0] is None
    agent_id = hive.db.one("SELECT agent_id FROM agent_credentials WHERE status = 'active'")["agent_id"]
    hive.db.execute("UPDATE agents SET token_epoch = token_epoch + 1 WHERE id = ?", (agent_id,))   # a mind retire/move
    assert tool(client, again, "hive_whoami")[0] == 401
    hive.db.execute("UPDATE agents SET token_epoch = token_epoch - 1 WHERE id = ?", (agent_id,))
    cred = hive.db.one("SELECT id FROM agent_credentials WHERE status = 'active'")["id"]
    r = client.delete(f"/api/admin/session-bridges/{cred}")
    assert r.status_code == 200 and r.json()["status"] == "revoked"
    assert tool(client, again, "hive_whoami")[0] == 401
    assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (agent_id,))["deleted"] == 0   # disconnect is not delete


def test_owner_tickets_and_refusals_without_one(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Lane"}).json()
    agent = hive.create_agent("Theory", "module", sw["id"], "mock/echo")
    assert sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Theory"}) == {
        "status": "refused", "code": "not_excepted"}
    member = person(client, "u_mem")
    assert client.post("/api/admin/session-bridges", json={"agent_id": agent["id"]}, headers=member).status_code == 403
    ticket = client.post("/api/admin/session-bridges", json={"agent_id": agent["id"]}).json()
    assert ticket["mixed_context"] is True and ticket["id"].startswith("sb_")
    reply = sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "ticket": ticket["id"]})
    assert reply["status"] == "issued" and reply["name"] == "Theory"
    assert tool(client, reply["token"], "hive_whoami")[1]["id"] == agent["id"]
    assert tool(client, agent["token"], "hive_whoami")[1]["id"] == agent["id"]        # attach: the member token is untouched
    assert sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "ticket": ticket["id"]}) == {
        "status": "refused", "code": "not_found"}                                    # one use
    assert tool(client, reply["token"], cr.MIGRATION_TOOL, {"op": "retire"})[0] == "mixed_context_refused"
    for bad in ({"op": "bridge"}, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot", "ticket": "sb_ab"},
                {"op": "bridge", "harness": "vim", "binding": BINDING, "mind": "Dot"},
                {"op": "bridge", "harness": "claude-code", "binding": "../x", "mind": "Dot"}):
        assert sl.answer(hive, SETTINGS, bad)["status"] == "refused"
    view = client.get("/api/admin/session-bridges").json()
    assert view["exception"]["names"] == ["Dot", "Surface"] and view["launch_socket"] == "unavailable"
    assert all("token" not in json.dumps(c) for c in view["credentials"])


def test_an_exception_mind_is_created_with_no_role_and_an_unmatchable_member_hash(client):
    hive = client.app.state.hive
    reply = bridge(client, mind="Surface")
    agent = hive.db.one("SELECT * FROM agents WHERE name = 'Surface'")
    assert agent["role_id"] in (None, "") and hive.db.one("SELECT name FROM swarms WHERE id = ?", (agent["swarm_id"],))["name"] == cr.BRIDGE_SWARM
    assert reply["credential"]["agent_id"] == agent["id"]


def test_legacy_retire_keeps_the_new_credential_and_can_roll_back(client):
    """§S/§U/§X: unmatchable legacy hash by compare-and-swap, epoch unchanged, old hash saved; rollback and rerun."""
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Platform"}).json()
    legacy = hive.create_agent("Dot", "module", sw["id"], "mock/echo", owner=hive.ownhive.owner())   # Dot's old credential
    assert tool(client, legacy["token"], "hive_whoami")[1]["id"] == legacy["id"]
    new = bridge(client)["token"]
    assert tool(client, new, "hive_whoami")[1]["id"] == legacy["id"]        # attached to the existing mind
    epoch = hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (legacy["id"],))["token_epoch"]
    # interrupted after retirement, before the whoami check: a rerun answers unchanged; rollback restores
    assert tool(client, new, cr.MIGRATION_TOOL, {"op": "retire"})[1] == {"state": "retired", "unchanged": False}
    assert tool(client, legacy["token"], "hive_whoami")[0] == 401
    assert client.get("/api/repo-maps", headers={"Authorization": f"Bearer {legacy['token']}"}).status_code == 401
    assert tool(client, new, cr.MIGRATION_TOOL, {"op": "retire"})[1] == {"state": "retired", "unchanged": True}
    assert tool(client, new, cr.MIGRATION_TOOL, {"op": "rollback"})[1]["state"] == "rolled_back"
    assert tool(client, legacy["token"], "hive_whoami")[0] is None              # both valid again, nothing lost
    # the full run: retire, whoami again with the new credential, confirm
    assert tool(client, new, cr.MIGRATION_TOOL, {"op": "retire"})[1]["state"] == "retired"
    assert tool(client, new, "hive_whoami")[1]["id"] == legacy["id"]
    assert tool(client, new, cr.MIGRATION_TOOL, {"op": "confirm"})[1] == {"state": "done", "unchanged": False}
    assert rows(hive, "legacy_credential_migrations") == 0
    assert tool(client, legacy["token"], "hive_whoami")[0] == 401
    assert hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (legacy["id"],))["token_epoch"] == epoch
    assert tool(client, new, "hive_inbox")[0] is None


class _Resp:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_the_launcher_execs_strict_with_the_token_only_in_the_environment(monkeypatch):
    token = "ohb1_" + "s" * 43
    seen, calls = {}, []

    def connect(path, request):
        seen["request"], seen["path"] = request, str(path)
        return {"status": "issued", "token": token, "name": "Dot", "mcp_url": "http://127.0.0.1:8700/mcp",
                "credential": {"id": "cr_1"}}

    def opener(req, timeout):
        body = json.loads(req.data)
        calls.append((body["params"]["name"], req.headers["Authorization"] == "Bearer " + token))
        if body["params"]["name"] == "hive_whoami":
            return _Resp({"result": {"structuredContent": {"name": "Dot"}}})
        return _Resp({"result": {"structuredContent": {"state": "ok"}}})

    def execvpe(file, argv, env):
        seen["argv"], seen["env"] = argv, env

    out = io.StringIO()
    args = types.SimpleNamespace(harness="claude-code", session=None, ticket=None, mind="Dot", replace=False,
                                 socket=None, data_dir="/hive-data", migrate_legacy=True)
    monkeypatch.delenv(sl.ENV_SOCKET, raising=False)
    assert sl.launch(args, ["--model", "x"], out=out, opener=opener, execvpe=execvpe, connect=connect) == 0
    assert seen["path"] == "/hive-data/launch/session.sock" and seen["request"]["mind"] == "Dot"
    argv = seen["argv"]
    assert argv[:3] == ["claude", "--strict-mcp-config", "--mcp-config"]
    config = json.loads(argv[3])
    assert config == {"mcpServers": {"omegahive-dot": {"type": "http", "url": "http://127.0.0.1:8700/mcp",
                                                       "headers": {"Authorization": "Bearer ${OMEGAHIVE_TOKEN_DOT}"}}}}
    assert argv[4:6] == ["--session-id", seen["request"]["binding"]] and argv[-2:] == ["--model", "x"]
    assert seen["env"]["OMEGAHIVE_TOKEN_DOT"] == token
    assert token not in " ".join(argv) and token not in out.getvalue()
    assert [c[0] for c in calls] == ["hive_whoami", cr.MIGRATION_TOOL, "hive_whoami", cr.MIGRATION_TOOL] and all(c[1] for c in calls)
    codex = sl.harness_argv("codex", "Surface", "http://127.0.0.1:8700/mcp", [])
    assert codex[:2] == ["codex", "--ignore-user-config"] and 'bearer_token_env_var="OMEGAHIVE_TOKEN_SURFACE"' in codex[-1]
    # a refusal or a failed identity check launches nothing
    seen.clear()
    assert sl.launch(args, [], out=out, opener=opener, execvpe=execvpe,
                     connect=lambda p, r: {"status": "refused", "code": "already_bridged"}) == 2 and "argv" not in seen
    bad = lambda req, timeout: _Resp({"result": {"structuredContent": {"name": "Someone"}}})  # noqa: E731
    assert sl.launch(args, [], out=out, opener=bad, execvpe=execvpe, connect=connect) == 3 and "argv" not in seen


def test_the_socket_runs_only_on_a_loopback_hive():
    env = {}
    assert sl._loopback_only(types.SimpleNamespace(public_url="http://127.0.0.1:8700"), env)
    assert not sl._loopback_only(types.SimpleNamespace(public_url="http://127.0.0.1:8700"), {"HIVE_PUBLIC_BASE": "https://x.example"})
    assert not sl._loopback_only(types.SimpleNamespace(public_url="https://hive.example"), env)


# ---- security review fixes (SHIP-WITH-FIXES on 32646eca) ------------------------------------------------------------

def test_f1_the_token_goes_only_to_the_literal_ipv4_loopback(client, monkeypatch):
    hive = client.app.state.hive
    reply = sl.answer(hive, types.SimpleNamespace(public_url="http://localhost:8700"),
                      {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot"})
    assert reply["mcp_url"] == "http://127.0.0.1:8700/mcp"                       # never public_url
    sent = []
    args = types.SimpleNamespace(harness="claude-code", session=None, ticket=None, mind="Dot", replace=False,
                                 socket="/x", data_dir=None, migrate_legacy=False)
    for url in ("http://[::1]:8700/mcp", "http://localhost:8700/mcp", "https://127.0.0.1:8700/mcp",
                "http://127.0.0.1.evil.example:8700/mcp", "http://u@127.0.0.1:8700/mcp"):
        connect = lambda p, r, url=url: {"status": "issued", "token": "ohb1_" + "t" * 43, "name": "Dot", "mcp_url": url,
                                         "credential": {"id": "cr"}}
        assert sl.launch(args, [], out=io.StringIO(), opener=lambda *a, **k: sent.append(a), execvpe=lambda *a: sent.append(a),
                         connect=connect) == 4
    assert sent == []
    assert not sl._loopback_only(types.SimpleNamespace(public_url="http://127.0.0.1:8700"), {"HIVE_BASE_PATH": "/omegahive"})


def test_the_launcher_checks_the_socket_servers_uid(monkeypatch):
    import socket
    from hive.core import localowner
    a, b = socket.socketpair()
    with a, b:
        sl.check_peer(a)                                                             # this account: accepted
        monkeypatch.setattr(localowner, "peer_uid", lambda sock: os.geteuid() + 1)
        with pytest.raises(OSError):
            sl.check_peer(a)
    out = io.StringIO()
    args = types.SimpleNamespace(harness="claude-code", session=None, ticket=None, mind="Dot", replace=False,
                                 socket="/nonexistent/launch.sock", data_dir=None, migrate_legacy=False)
    assert sl.launch(args, [], out=out, execvpe=lambda *a: None) == 2 and "socket_" in out.getvalue()


def test_f2_exception_minds_are_bound_by_immutable_id(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Somebody"}).json()
    impostor = hive.create_agent("Surface", "module", sw["id"], "mock/echo", owner="user:u_somebody")   # not the owner's
    assert sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Surface"}) == {
        "status": "refused", "code": "not_owner_mind"}
    hive.create_agent("Surface", "module", sw["id"], "mock/echo", owner=hive.ownhive.owner())
    assert sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Surface"}) == {
        "status": "refused", "code": "ambiguous_mind"}
    first = bridge(client)                                                            # Dot: created by the host, bound
    dot_id = first["credential"]["agent_id"]
    swarm_id = hive.db.one("SELECT swarm_id FROM agents WHERE id = ?", (dot_id,))["swarm_id"]
    hive.db.execute("UPDATE swarms SET name = 'renamed' WHERE id = ?", (swarm_id,))
    hive.create_agent("Dot", "module", sw["id"], "mock/echo", owner=hive.ownhive.owner())   # a later same-name mind
    again = bridge(client)                                                            # still the bound id
    assert again["credential"]["agent_id"] == dot_id
    hive.db.execute("DELETE FROM agents WHERE id = ?", (impostor["id"],))
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE name = 'Surface' AND id != ?", (impostor["id"],))
    surface = bridge(client, mind="Surface", binding="0b5e5510-aaaa-4bbb-8ccc-000000000009")
    assert hive.db.one("SELECT swarm_id FROM agents WHERE id = ?", (surface["credential"]["agent_id"],))["swarm_id"] == swarm_id
    # the migration tool follows the bound id, not the name
    other = hive.db.one("SELECT id FROM agents WHERE name = 'Dot' AND id != ?", (dot_id,))["id"]
    assert not hive.credentials._excepted(other) and hive.credentials._excepted(dot_id)


def test_the_exception_ends_and_the_migration_tool_stops_existing(client):
    hive = client.app.state.hive
    token = bridge(client)["token"]
    tool(client, token, "hive_whoami")
    member = person(client, "u_mem")
    assert client.post("/api/admin/session-bridges/exception/end", headers=member).status_code == 403
    assert client.get("/api/admin/session-bridges", headers=member).status_code == 403
    assert client.delete("/api/admin/session-bridges/cr_x", headers=member).status_code == 403
    ended = client.post("/api/admin/session-bridges/exception/end").json()
    assert ended["ended_at"] and list(ended["bound"]) == ["Dot"]
    listed = {t["name"] for t in rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert cr.MIGRATION_TOOL not in listed
    assert tool(client, token, cr.MIGRATION_TOOL, {"op": "retire"})[0] == "mixed_context_refused"
    assert sl.answer(hive, SETTINGS, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Surface"}) == {
        "status": "refused", "code": "exception_ended"}
    relaunch = bridge(client)                                                         # the bound mind relaunches read-only
    assert tool(client, relaunch["token"], "hive_whoami")[0] is None


def test_a_rollback_that_changes_nothing_says_so(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P"}).json()
    legacy = hive.create_agent("Dot", "module", sw["id"], "mock/echo", owner=hive.ownhive.owner())
    hive.credentials.retire_legacy_credential(legacy["id"])
    hive.db.execute("UPDATE agents SET token_hash = 'changed-meanwhile' WHERE id = ?", (legacy["id"],))
    assert hive.credentials.rollback_legacy_retire(legacy["id"]) == {"state": "rollback_failed", "unchanged": True}
    assert rows(hive, "legacy_credential_migrations") == 1


def test_a_migration_never_crashes_and_reports_its_rollback_truthfully():
    token = "ohb1_" + "s" * 43
    connect = lambda p, r: {"status": "issued", "token": token, "name": "Dot", "mcp_url": "http://127.0.0.1:8700/mcp",
                            "credential": {"id": "cr_1"}}
    args = types.SimpleNamespace(harness="claude-code", session=None, ticket=None, mind="Dot", replace=False,
                                 socket="/x", data_dir=None, migrate_legacy=True)
    for rollback, expect in (({"state": "rolled_back"}, "both stay valid"), (None, "did not confirm")):
        calls = []

        def opener(req, timeout, rollback=rollback):
            name = json.loads(req.data)["params"]["name"]
            op = json.loads(req.data)["params"]["arguments"].get("op")
            calls.append(op or name)
            if name == "hive_whoami" and calls.count("hive_whoami") == 1:
                return _Resp({"result": {"structuredContent": {"name": "Dot"}}})
            if name == "hive_whoami":
                raise OSError("connection reset")                                    # the re-check fails mid-migration
            if op == "rollback" and rollback is None:
                raise OSError("connection reset")
            return _Resp({"result": {"structuredContent": rollback if op == "rollback" else {"state": "retired"}}})

        out, launched = io.StringIO(), []
        assert sl.launch(args, [], out=out, opener=opener, execvpe=lambda *a: launched.append(a), connect=connect) == 0
        assert calls == ["hive_whoami", "retire", "hive_whoami", "rollback"] and expect in out.getvalue() and launched
