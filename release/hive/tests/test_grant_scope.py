"""A person's grant scope bounds every Code capability minted for them (stand-in MISSING-UI B1 r3 #1, 2026-10-07).

A read grant never yields edit, run, checkpoint, workspace or any other write-capable capability: the relay refuses the route
with 403 grant_scope before minting a token or calling Code, and Services.issue refuses it again (defence in depth). An edit
grant is unchanged. Synthetic only: a fake Code transport, no provider calls."""
import asyncio
import base64
import hashlib
import json
import re
import secrets

import httpx
import pytest

from hive.core.code import PROXY_ROUTES, Code
from hive.core.db import now
from hive.core.services import ACTIONS, GRANT_SCOPE_ACTIONS, ServiceError
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

READ_CLASS = {"read", "search", "events", "artifact"}


class FakeCode:
    def __init__(self):
        self.calls = []

    async def request(self, method, url, params=None, content=None, headers=None, timeout=None):
        payload = headers["Authorization"].split()[1].split(".")[1]
        self.calls.append((method, url, json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))))
        return httpx.Response(200, json={"ok": True})


class World:
    pass


@pytest.fixture()
def g(client, monkeypatch, tmp_path):  # noqa: F811
    hive = client.app.state.hive
    # the run route (POST /v1/runs) is a native start: after the grant checks this file is about, it also needs the
    # repository registered and the operator's trusted-native service config (code.py _require_native_start_policy)
    monkeypatch.setattr(hive.code, "repos", {"synthetic": {"path": str(hive.code.platform_root)}})
    config = tmp_path / "code-service.json"
    config.write_text(json.dumps({"repositories": {"synthetic": {"path": str(hive.code.platform_root)}}}))
    monkeypatch.setenv("HIVE_CODE_SERVICE_CONFIG", str(config))
    monkeypatch.setattr(Code, "_loaded_release_mismatch", lambda self: None)
    import hive.core.code as code_module   # relay-proof transport is covered against real listeners in the interop tests
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset())
    token = secrets.token_urlsafe(16)
    hive.db.insert("services", {"id": "svc_code", "name": "omegacode", "version": "1", "address": "http://127.0.0.1:8724",
                                "contract": "omegacode/1", "surfaces": "[]", "capabilities": "[]",
                                "token_hash": hashlib.sha256(token.encode()).hexdigest(), "capability_secret": "secret",
                                "registered_at": now()})
    x = World()
    x.hive, x.client, x.fake = hive, client, FakeCode()
    monkeypatch.setattr(hive.code, "client", x.fake)
    swarm = client.post("/api/swarms", json={"name": "Code local"}).json()
    x.task = asyncio.run(hive.goals.create(swarm["id"], "Edit code: synthetic", created_by="user:operator"))
    x.read = hive.services.grant(x.task["id"], "user:operator", "read", None, 120)
    x.edit = hive.services.grant(x.task["id"], "user:operator", "edit", None, 120)
    return x


def sample(pattern, task_id):
    path = pattern.strip("^$").replace(r"(runs|verifications|diagnostics)", "runs")
    path = re.sub(r"\[[^\]]+\]\{(\d+)\}", lambda m: "a" * int(m.group(1)), path)
    path = path.replace("[A-Za-z0-9_-]+", "a")
    path = path.replace("/v1/tasks/g_a/", f"/v1/tasks/{task_id}/")
    assert re.fullmatch(pattern, path), (pattern, path)
    return path


def relay(g, method, path, grant):
    query = {"task_id": g.task["id"], "repository_id": "synthetic", "grant_id": grant["id"]}
    return g.client.request(method, "/api/code/proxy" + path, params=query, json={} if method == "POST" else None)


def capabilities(hive):
    return hive.db.one("SELECT COUNT(*) AS n FROM capabilities")["n"]


WRITE_ROUTES = [(m, p, a) for m, p, a in PROXY_ROUTES if not set(a) <= READ_CLASS]
READ_ROUTES = [(m, p, a) for m, p, a in PROXY_ROUTES if set(a) <= READ_CLASS]


def test_the_read_scope_is_codes_read_class_and_edit_is_everything():
    assert GRANT_SCOPE_ACTIONS["read"] == READ_CLASS and GRANT_SCOPE_ACTIONS["edit"] == ACTIONS
    assert WRITE_ROUTES and READ_ROUTES


@pytest.mark.parametrize("method,pattern,actions", WRITE_ROUTES, ids=[f"{m} {p}" for m, p, _ in WRITE_ROUTES])
def test_a_read_grant_is_refused_on_every_write_route_before_any_token_or_call(g, method, pattern, actions):
    before = capabilities(g.hive)
    out = relay(g, method, sample(pattern, g.task["id"]), g.read)
    assert out.status_code == 403 and out.json()["error"]["code"] == "grant_scope", out.text
    assert g.fake.calls == [] and capabilities(g.hive) == before


@pytest.mark.parametrize("method,pattern,actions", READ_ROUTES, ids=[f"{m} {p}" for m, p, _ in READ_ROUTES])
def test_a_read_grant_works_on_read_routes(g, method, pattern, actions):
    out = relay(g, method, sample(pattern, g.task["id"]), g.read)
    assert out.status_code == 200, out.text
    claims = g.fake.calls[-1][2]
    assert set(claims["actions"]) == set(actions) and claims["grant_id"] == g.read["id"]


@pytest.mark.parametrize("method,pattern,actions", PROXY_ROUTES, ids=[f"{m} {p}" for m, p, _ in PROXY_ROUTES])
def test_an_edit_grant_is_unchanged_on_every_route(g, method, pattern, actions):
    out = relay(g, method, sample(pattern, g.task["id"]), g.edit)
    assert out.status_code == 200, out.text
    assert set(g.fake.calls[-1][2]["actions"]) == set(actions)


def test_services_issue_refuses_read_grant_plus_write_actions(g):
    issue = lambda grant, actions: g.hive.services.issue(  # noqa: E731
        "svc_code", actor="user:operator", kind="human", task_id=g.task["id"], swarm_id=g.task["swarm_id"],
        repository_id="synthetic", actions=actions, grant_id=grant["id"])
    for action in sorted(ACTIONS - READ_CLASS):
        with pytest.raises(ServiceError) as refused:
            issue(g.read, ["read", action])
        assert refused.value.status == 403 and refused.value.code == "grant_scope", action
    assert issue(g.read, sorted(READ_CLASS))["claims"]["actions"] == sorted(READ_CLASS)
    assert issue(g.edit, sorted(ACTIONS))["claims"]["actions"] == sorted(ACTIONS)
    with pytest.raises(ServiceError) as refused:
        issue({"id": "gr_missing"}, ["read"])
    assert refused.value.code == "grant_scope"


def test_the_person_capability_route_refuses_write_actions_on_a_read_grant(g):
    out = g.client.post("/api/code/capability", json={"task_id": g.task["id"], "grant_id": g.read["id"], "actions": ["edit"]})
    assert out.status_code == 403 and out.json()["error"]["code"] == "grant_scope"
    out = g.client.post("/api/code/capability", json={"task_id": g.task["id"], "grant_id": g.read["id"], "actions": ["read"]})
    assert out.status_code == 200, out.text


def test_a_downgraded_grant_stops_reusing_a_cached_write_token(g):
    path = "/v1/workspaces/ws_a/patches"
    assert relay(g, "POST", path, g.edit).status_code == 200
    g.hive.db.execute("UPDATE goal_grants SET scope = 'read' WHERE id = ?", (g.edit["id"],))
    out = relay(g, "POST", path, g.edit)
    assert out.status_code == 403 and out.json()["error"]["code"] == "grant_scope"
    assert len(g.fake.calls) == 1
