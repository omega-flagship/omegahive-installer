"""The owner's AI subscriptions through local CLI bridges (subscription_cli.py, CLI route R3 §I/§M): every test that
takes `sub` runs for each instance of the family, subscription-cli (Claude) and subscription-codex (ChatGPT/Codex).

Synthetic only: a fake bridge transport, invented ids and an invented bridge key; no network, no CLI."""

import asyncio
import dataclasses
import json
import pathlib
import sqlite3
import tempfile

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import (SUBSCRIPTION_CLI, SUBSCRIPTION_CODEX, SUBSCRIPTIONS, Provider, _load_providers,
                              is_subscription, load_settings)
from hive.core.gateway import Gateway, GatewayError
from hive.core.providers import LABELS
from hive.core.subscription_cli import SubscriptionGate, owner_scope
from hive.tests.test_core_api import PETTA, FakeSupervisor, agent_headers, make_swarm_and_agents
from hive.tests.test_visibility import person

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

OWNER = "user:u_0wner001"
OTHER = "user:u_member01"
ANSWER = {"model": "invented", "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}}],
          "usage": {"prompt_tokens": 13, "completion_tokens": 5}}


@dataclasses.dataclass(frozen=True)
class Sub:
    """One subscription instance, with invented bridge details."""
    name: str
    bridge: str
    key: str
    models: tuple

    @property
    def prefix(self):
        return SUBSCRIPTIONS[self.name]

    @property
    def key_env(self):
        return f"{self.prefix}_KEY"

    @property
    def model(self):
        return f"{self.name}/{self.models[0]}"

    @property
    def port(self):
        return self.bridge.split(":")[2].split("/")[0]

    def env(self, suffix):
        return f"{self.prefix}_{suffix}"


CLI = Sub(SUBSCRIPTION_CLI, "http://127.0.0.1:8791/v1", "invented-bridge-key-0001", ("claude-sonnet", "claude-opus"))
CODEX = Sub(SUBSCRIPTION_CODEX, "http://127.0.0.1:8792/v1", "invented-bridge-key-0002",
            ("codex-cli-gpt-6.1-sol", "codex-cli-gpt-6.1"))
INSTANCES = (CLI, CODEX)
ENV = tuple(f"{i.prefix}_{suffix}" for i in INSTANCES for suffix in ("URL", "KEY", "MODELS", "DAILY_CALLS", "SWARMS")) + (
    "HIVE_LOCAL_ONLY_SWARMS", "HIVE_PROVIDERS_FILE", "HIVE_LOCAL_LLM_URL", "HIVE_HOST")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(params=INSTANCES, ids=[i.name for i in INSTANCES])
def sub(request):
    return request.param


def configure(monkeypatch, sub, cap=None):
    monkeypatch.setenv(sub.env("URL"), sub.bridge)
    monkeypatch.setenv(sub.env("KEY"), sub.key)
    monkeypatch.setenv(sub.env("MODELS"), ", ".join(sub.models))
    if cap is not None:
        monkeypatch.setenv(sub.env("DAILY_CALLS"), str(cap))


class Bridge(httpx.AsyncBaseTransport):
    """A fake bridge that, like httpcore, calls the request's trace at send_request_headers.started before anything
    counts as sent. queued: run before that point (the wait for a pooled connection); answer: the body to return."""

    def __init__(self, answer=ANSWER, status=200, queued=None):
        self.answer, self.status, self.queued, self.sent, self.seen = answer, status, queued, [], []

    async def handle_async_request(self, request):
        self.seen.append(request)
        if self.queued is not None:
            self.queued()
        trace = request.extensions.get("trace")
        if trace is not None:
            await trace("http11.send_request_headers.started", {})
        self.sent.append(request)
        return httpx.Response(self.status, json=self.answer)


# ---- configuration ------------------------------------------------------------------------------------------------

def test_absent_when_unconfigured(sub):
    assert sub.name not in _load_providers()


def test_present_when_configured_and_never_local(monkeypatch, sub):
    configure(monkeypatch, sub)
    providers = _load_providers()
    provider = providers[sub.name]
    assert provider.local is False and provider.base_url == sub.bridge and is_subscription(sub.name)
    assert provider.models == list(sub.models) and provider.api_key == sub.key and provider.key_env == sub.key_env
    assert provider.prices == {} and "free" not in LABELS[sub.name].lower()
    assert providers["local"].local is True   # the local slot is untouched
    assert [n for n in SUBSCRIPTIONS if n in providers] == [sub.name]   # the other instance stays off


def test_both_instances_at_once(monkeypatch):
    configure(monkeypatch, CLI)
    configure(monkeypatch, CODEX)
    providers = _load_providers()
    assert providers[CLI.name].base_url == CLI.bridge and providers[CODEX.name].base_url == CODEX.bridge
    assert LABELS[CODEX.name] == "ChatGPT subscription (this Mac)"


@pytest.mark.parametrize("url", ["http://127.0.0.1:8791/v1", "http://127.0.0.2:8791/other", "http://[::1]:8791/v1"])
def test_second_instance_on_the_first_bridge_is_off(monkeypatch, url):
    configure(monkeypatch, CLI)
    configure(monkeypatch, CODEX)
    monkeypatch.setenv(CODEX.env("URL"), url)
    providers = _load_providers()
    assert CLI.name in providers and CODEX.name not in providers


@pytest.mark.parametrize("url", ["https://bridge.invalid/v1", "http://192.168.1.5:8791/v1", "ftp://127.0.0.1/v1",
                                 "http://user:pw@127.0.0.1:8791/v1", "http://127.0.0.1:8791/v1?x=1",
                                 "http://localhost:8791/v1", "http://[::1/v1", "http://127.0.0.1:notaport/v1"])
def test_non_literal_loopback_or_malformed_bridge_is_off_not_a_crash(monkeypatch, sub, url):
    monkeypatch.setenv(sub.env("URL"), url)
    assert sub.name not in _load_providers()


ENTRIES = [
    lambda s, o: {"name": s.name, "base_url": "http://127.0.0.1:9999/v1", "local": True},
    lambda s, o: {"name": o.name, "base_url": "http://127.0.0.1:9999/v1", "local": True},   # the unconfigured sibling
    lambda s, o: {"name": "sneaky", "base_url": s.bridge, "local": True},
    lambda s, o: {"name": "sneaky", "base_url": f"http://localhost:{s.port}/other", "local": True},
    lambda s, o: {"name": "sneaky", "base_url": f"http://[::1]:{s.port}/v1", "local": True},
    lambda s, o: {"name": "sneaky", "base_url": "http://127.0.0.1:1234/v1", "key_env": s.key_env},
    lambda s, o: {"name": "sneaky", "base_url": "http://127.0.0.1:1234/v1", "key_env": o.key_env}]


@pytest.mark.parametrize("entry", range(len(ENTRIES)))
def test_providers_file_entries_aimed_at_the_bridge_are_refused(monkeypatch, tmp_path, sub, entry):
    other = CODEX if sub is CLI else CLI
    path = tmp_path / "providers.json"
    path.write_text(json.dumps([dict(ENTRIES[entry](sub, other), models=["x"]),
                                {"name": "fine", "base_url": "http://127.0.0.1:1234/v1", "local": True, "models": ["y"]}]))
    monkeypatch.setenv("HIVE_PROVIDERS_FILE", str(path))
    configure(monkeypatch, sub)
    providers = _load_providers()
    assert "sneaky" not in providers and other.name not in providers
    assert providers["fine"].base_url == "http://127.0.0.1:1234/v1"
    assert providers[sub.name].local is False and providers[sub.name].base_url == sub.bridge


def test_providers_file_entry_on_either_bridge_port_refused_when_both_run(monkeypatch, tmp_path):
    path = tmp_path / "providers.json"
    path.write_text(json.dumps([{"name": "a", "base_url": f"http://localhost:{CLI.port}/v1", "local": True},
                                {"name": "b", "base_url": f"http://localhost:{CODEX.port}/v1", "local": True}]))
    monkeypatch.setenv("HIVE_PROVIDERS_FILE", str(path))
    configure(monkeypatch, CLI)
    configure(monkeypatch, CODEX)
    providers = _load_providers()
    assert "a" not in providers and "b" not in providers


def test_builtin_local_slot_on_the_bridge_port_is_switched_off(monkeypatch, sub):
    configure(monkeypatch, sub)
    monkeypatch.setenv("HIVE_LOCAL_LLM_URL", f"http://127.0.0.1:{sub.port}/v1")
    import importlib
    from hive.core import config
    importlib.reload(config)   # DEFAULT_PROVIDERS reads HIVE_LOCAL_LLM_URL at import
    try:
        assert config._load_providers()["local"].base_url == ""
    finally:
        monkeypatch.delenv("HIVE_LOCAL_LLM_URL")
        importlib.reload(config)


# ---- the one owner-scope policy -----------------------------------------------------------------------------------

def _swarm(**kw):
    return dict({"id": "s_00000001", "owner": OWNER, "visibility": "private", "personal_of": None, "archived_at": None}, **kw)


@pytest.mark.parametrize("mind_owner,swarm,minds,allowed,admitted", [
    (OWNER, _swarm(), [OWNER], (), True),                                              # owner-created, private
    (OWNER, _swarm(owner=None, personal_of=OWNER), [OWNER], (), True),                 # personal, private
    (OWNER, _swarm(owner=None, personal_of=OWNER, visibility="shared"), [OWNER], (), False),   # Codex P1-1
    (OWNER, _swarm(owner=None, personal_of=OWNER, visibility="public"), [OWNER], (), False),
    (OWNER, _swarm(visibility="shared"), [OWNER], (), False),
    (OWNER, _swarm(visibility="public"), [OWNER], (), False),                          # e.g. Create · Code, not opted in
    (OWNER, _swarm(visibility="public"), [OWNER, OTHER], ("s_00000001",), True),       # opted in: owner-created
    (OWNER, _swarm(owner=OTHER, visibility="public"), [OWNER], ("s_00000001",), False),   # opted in, not the owner's
    (OTHER, _swarm(visibility="public"), [OTHER], ("s_00000001",), False),             # opted in, mind not the owner's
    (OWNER, _swarm(), [OWNER, OTHER], (), False),                                      # private, another's mind inside
    (OTHER, _swarm(), [OTHER], (), False),
    (OWNER, _swarm(owner=OTHER), [OWNER], (), False),                                  # another person's team
    (OWNER, _swarm(archived_at="2026-11-01T00:00:00Z"), [OWNER], ("s_00000001",), False),
])
def test_owner_scope_matrix(mind_owner, swarm, minds, allowed, admitted):
    assert owner_scope(OWNER, {"owner": mind_owner}, swarm, minds, frozenset(allowed)) is admitted


def test_owner_scope_needs_a_named_owner():
    assert owner_scope("user:operator", {"owner": "user:operator"}, _swarm(owner="user:operator"),
                       ["user:operator"], frozenset()) is False


@pytest.mark.parametrize("raw", ["not json", "{}", "[1]", '[""]'])
def test_unreadable_allowlist_admits_none(monkeypatch, sub, raw):
    from hive.core.subscription_cli import allowed_swarms
    monkeypatch.setenv(sub.env("SWARMS"), raw)
    assert allowed_swarms(sub.name) == frozenset()
    assert owner_scope(OWNER, {"owner": OWNER}, _swarm(visibility="public"), [OWNER], allowed_swarms(sub.name)) is False


def test_allowlist_and_cap_are_per_instance(monkeypatch):
    from hive.core.subscription_cli import allowed_swarms, daily_cap
    monkeypatch.setenv(CODEX.env("SWARMS"), '["s_00000001"]')
    monkeypatch.setenv(CODEX.env("DAILY_CALLS"), "7")
    assert allowed_swarms(CODEX.name) == {"s_00000001"} and allowed_swarms(CLI.name) == frozenset()
    assert allowed_swarms() == frozenset()   # the single-instance default is subscription-cli's
    assert (daily_cap(CODEX.name), daily_cap(CLI.name), daily_cap("openai")) == (7, 500, 0)


# ---- gateway, with no hive ----------------------------------------------------------------------------------------

class AdmitAll:
    def __init__(self):
        self.calls = []

    def admit(self, agent, principal=None, dispatch=False, provider=None):
        self.calls.append(("admit", principal, dispatch, provider))

    def authorize(self, agent, principal=None, provider=None):
        self.calls.append(("authorize", principal, provider))


def fake_gateway(bridge, sub):
    gate = Gateway({sub.name: Provider(sub.name, sub.bridge, sub.key_env, local=False)})
    asyncio.run(gate.client.aclose())
    gate.client = httpx.AsyncClient(transport=bridge)
    return gate


def agent_for(sub, **kw):
    return dict({"id": "a_00000001", "name": "invented", "model": sub.model, "swarm_id": "s_00000001"}, **kw)


@pytest.mark.parametrize("operation", ["estimate", "chat", "embeddings"])
def test_local_only_swarm_refused_before_any_network(monkeypatch, sub, operation):
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", '["s_protect1"]')
    bridge = Bridge()
    gate = fake_gateway(bridge, sub)
    gate.subscription_gate = AdmitAll()   # even a gate that admits everything never sees it
    agent = agent_for(sub, swarm_id="s_protect1")
    body = {"messages": [{"role": "user", "content": "invented canary"}]}
    async def run():
        with pytest.raises(GatewayError) as refusal:
            if operation == "estimate":
                gate.estimate(agent, body)
            elif operation == "chat":
                await gate.chat(agent, body)
            else:
                await gate.embeddings(sub.model, {"input": "invented canary"}, agent=agent)
        assert refusal.value.code == "egress_refused"
    asyncio.run(run())
    assert bridge.seen == [] and gate.subscription_gate.calls == []


def test_no_gate_attached_refuses(sub):
    gate = fake_gateway(Bridge(), sub)
    with pytest.raises(GatewayError) as refusal:
        gate.estimate(agent_for(sub), {"messages": []})
    assert refusal.value.code == "subscription_unavailable"


def test_gateway_records_plan_usage_and_rechecks_at_the_send_boundary(monkeypatch, sub):
    configure(monkeypatch, sub)
    bridge = Bridge(answer=dict(ANSWER, usage={"prompt_tokens": 11, "completion_tokens": 7, "cost": 0.42}))
    gate = fake_gateway(bridge, sub)
    gate.subscription_gate = AdmitAll()
    gate.paying_key = lambda *a: pytest.fail("a subscription never looks for a paying key")
    agent = agent_for(sub)
    assert gate.estimate(agent, {"messages": []}, principal=OWNER) == (False, 0.0)
    _, usage = asyncio.run(gate.chat(agent, {"messages": [{"role": "user", "content": "hi"}]}, principal=OWNER))
    assert usage["cost_usd"] == 0.0 and usage["reported_cost_usd"] is None and usage["payer_mode"] == "plan"
    assert (usage["prompt_tokens"], usage["completion_tokens"], usage["key_id"]) == (11, 7, None)
    assert bridge.sent[0].headers["authorization"] == f"Bearer {sub.key}"
    assert json.loads(bridge.sent[0].content)["model"] == sub.models[0]
    # admitted at the estimate, again (counted) before dispatch, and authorized at the send boundary: with the principal
    # and this instance's name, so its own cap and bridge are judged
    assert gate.subscription_gate.calls == [("admit", OWNER, False, sub.name), ("admit", OWNER, True, sub.name),
                                            ("authorize", OWNER, sub.name)]


@pytest.mark.parametrize("usage", [None, {}, {"prompt_tokens": -1, "completion_tokens": 2},
                                   {"prompt_tokens": "3", "completion_tokens": 2}, {"prompt_tokens": 1.5, "completion_tokens": 2}])
def test_invalid_counters_are_not_recorded_as_plan_usage(monkeypatch, sub, usage):
    configure(monkeypatch, sub)
    answer = dict(ANSWER)
    answer.pop("usage")
    if usage is not None:
        answer["usage"] = usage
    gate = fake_gateway(Bridge(answer=answer), sub)
    gate.subscription_gate = AdmitAll()
    with pytest.raises(GatewayError) as refusal:
        asyncio.run(gate.chat(agent_for(sub), {"messages": [{"role": "user", "content": "hi"}]}))
    assert refusal.value.code == "upstream_usage_invalid"


# ---- the whole route, on a hive ------------------------------------------------------------------------------------

def make_client(monkeypatch, sub, cap=None):
    configure(monkeypatch, sub, cap=cap)
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")), admin_password="pw",
                             petta_path=PETTA)
    return TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0))


@pytest.fixture
def hive_client(monkeypatch, request, sub):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    with make_client(monkeypatch, sub, getattr(request, "param", None)) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        hive = test_client.app.state.hive
        set_owner(hive)
        test_client.hive = hive
        test_client.sub = sub
        test_client.bridge = use_bridge(hive, Bridge())
        yield test_client


def set_owner(hive, owner=OWNER):
    hive.db.execute("INSERT OR REPLACE INTO hive_owner (id, owner, via, set_at, updated_at) "
                    "VALUES (1, ?, 'test', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z')", (owner,))


def use_bridge(hive, bridge):
    old = hive.gateway.client
    hive.gateway.client = httpx.AsyncClient(transport=bridge)
    asyncio.run(old.aclose())
    return bridge


def owned_mind(client, mind_owner=OWNER, swarm_owner=OWNER, visibility="private", personal=False, model=None):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    db = client.hive.db
    db.execute("UPDATE swarms SET owner = ?, visibility = ?, personal_of = ? WHERE id = ?",
               (None if personal else swarm_owner, visibility, swarm_owner if personal else None, swarm["id"]))
    db.execute("UPDATE agents SET owner = ?, model = ? WHERE id = ?", (mind_owner, model or client.sub.model, agent["id"]))
    agent["swarm_id"] = swarm["id"]
    return agent


def call(client, agent):
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json={"messages": [{"role": "user", "content": "invented question"}]})


def usage_rows(client, agent):
    return client.hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (agent["id"],))


def test_owner_allowed_and_usage_recorded_as_plan(hive_client):
    agent = owned_mind(hive_client)
    response = call(hive_client, agent)
    assert response.status_code == 200, response.text
    assert len(hive_client.bridge.sent) == 1
    assert hive_client.bridge.sent[0].headers["authorization"] == f"Bearer {hive_client.sub.key}"
    assert str(hive_client.bridge.sent[0].url).startswith(hive_client.sub.bridge)
    (row,) = usage_rows(hive_client, agent)
    assert (row["prompt_tokens"], row["completion_tokens"], row["cost_usd"]) == (13, 5, 0.0)
    assert (row["payer"], row["payer_mode"], row["key_id"], row["model"]) == (OWNER, "plan", None, hive_client.sub.model)
    listed = hive_client.get("/api/usage", params={"agent_id": agent["id"]}).json()
    assert [u["payer_mode"] for u in (listed if isinstance(listed, list) else listed["usage"])] == ["plan"]


def test_personal_private_swarm_allowed(hive_client):
    assert call(hive_client, owned_mind(hive_client, personal=True)).status_code == 200


def test_tunnel_reached_hive_bound_to_loopback_is_allowed(hive_client, monkeypatch):
    monkeypatch.setattr(hive_client.hive.settings, "public_url", "https://hive.example.invalid")
    assert call(hive_client, owned_mind(hive_client)).status_code == 200


def test_opted_in_owner_created_public_swarm_allowed(hive_client, monkeypatch):
    agent = owned_mind(hive_client, visibility="public")
    assert call(hive_client, agent).status_code == 403
    other = CODEX if hive_client.sub is CLI else CLI
    monkeypatch.setenv(other.env("SWARMS"), json.dumps([agent["swarm_id"]]))   # another instance's opt-in is not this one's
    assert call(hive_client, agent).status_code == 403
    monkeypatch.setenv(hive_client.sub.env("SWARMS"), json.dumps([agent["swarm_id"]]))
    assert call(hive_client, agent).status_code == 200


def test_settlement_is_plan_never_free_and_honours_user_and_egress(hive_client, monkeypatch):
    hive = hive_client.hive
    model = hive_client.sub.model
    agent = hive._agent_row(owned_mind(hive_client)["id"])
    settled = hive.budgets.settlement(agent, model)
    assert settled["subscription"] is True and settled["free"] is False and settled["bounded"] is True
    assert (settled["payer"], settled["payer_mode"], settled["key_id"]) == (OWNER, "plan", None)
    assert hive.budgets.settlement(agent, model, user=OTHER)["reason"] == "subscription_owner_only"
    stranger = hive._agent_row(owned_mind(hive_client, mind_owner=OTHER)["id"])
    assert hive.budgets.settlement(stranger, model)["bounded"] is False
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", json.dumps([agent["swarm_id"]]))
    assert hive.budgets.settlement(agent, model)["reason"] == "egress_refused"


@pytest.mark.parametrize("case", ["member_mind", "team_swarm_of_other", "public_swarm", "shared_swarm",
                                  "shared_personal_swarm", "public_personal_swarm", "other_mind_in_swarm",
                                  "owner_is_operator", "hive_not_on_loopback", "opted_in_but_not_owners"])
def test_non_owner_refused_before_network(hive_client, monkeypatch, case):
    hive = hive_client.hive
    agent = owned_mind(hive_client,
                       mind_owner=OTHER if case == "member_mind" else OWNER,
                       swarm_owner=OTHER if case in ("team_swarm_of_other", "opted_in_but_not_owners") else OWNER,
                       visibility={"public_swarm": "public", "shared_swarm": "shared", "shared_personal_swarm": "shared",
                                   "public_personal_swarm": "public", "opted_in_but_not_owners": "public"}.get(case, "private"),
                       personal=case.endswith("personal_swarm"))
    if case == "other_mind_in_swarm":
        other = hive_client.post("/api/agents", json={"name": "Guest", "swarm_id": agent["swarm_id"]}).json()
        hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (OTHER, other["id"]))
    if case == "owner_is_operator":
        hive.db.execute("DELETE FROM hive_owner")
    if case == "hive_not_on_loopback":
        monkeypatch.setenv("HIVE_HOST", "0.0.0.0")
    if case == "opted_in_but_not_owners":
        monkeypatch.setenv(hive_client.sub.env("SWARMS"), json.dumps([agent["swarm_id"]]))
    response = call(hive_client, agent)
    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "subscription_owner_only"
    assert OWNER not in error["message"] and "u_" not in error["message"]
    assert hive_client.bridge.seen == [] and usage_rows(hive_client, agent) == []


def test_another_persons_open_ask_turn_on_the_mind_refuses(hive_client):
    agent = owned_mind(hive_client)
    db = hive_client.hive.db
    row = {"id": "at_invented1", "operation_id": "op-invented-1", "principal": OTHER, "mind_id": agent["id"],
           "state": "conducting", "created_at": "2026-11-07T00:00:00Z"}
    for col in db.all("PRAGMA table_info(ask_turns)"):   # every other required column: an inert placeholder
        if col["notnull"] and col["dflt_value"] is None and col["name"] not in row:
            row[col["name"]] = 0 if "INT" in (col["type"] or "").upper() or "REAL" in (col["type"] or "").upper() else "x"
    db.insert("ask_turns", row)
    assert call(hive_client, agent).status_code == 403 and hive_client.bridge.seen == []


def test_local_only_swarm_refused_on_the_route(hive_client, monkeypatch):
    agent = owned_mind(hive_client)
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", json.dumps([agent["swarm_id"]]))
    response = call(hive_client, agent)
    assert response.status_code == 403 and response.json()["error"]["code"] == "egress_refused"
    assert hive_client.bridge.seen == []


@pytest.mark.parametrize("change", ["owner", "visibility", "egress"])
def test_authority_rechecked_at_the_send_boundary(hive_client, monkeypatch, change):
    """The transport queued the request (a pooled-connection wait) and, meanwhile, authority changed: refused at
    send_request_headers.started with nothing sent."""
    hive = hive_client.hive
    agent = owned_mind(hive_client)
    def meanwhile():
        if change == "owner":
            hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (OTHER, agent["id"]))
        elif change == "visibility":
            hive.db.execute("UPDATE swarms SET visibility = 'public' WHERE id = ?", (agent["swarm_id"],))
        else:
            monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", json.dumps([agent["swarm_id"]]))
    bridge = use_bridge(hive, Bridge(queued=meanwhile))
    response = call(hive_client, agent)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == ("egress_refused" if change == "egress" else "subscription_owner_only")
    assert len(bridge.seen) == 1 and bridge.sent == [] and usage_rows(hive_client, agent) == []


@pytest.mark.parametrize("hive_client", [2], indirect=True)
def test_daily_cap_counts_attempts_and_survives_a_restart(hive_client):
    hive = hive_client.hive
    agent = owned_mind(hive_client)
    use_bridge(hive, Bridge(status=500, answer={"error": "invented"}))   # attempts that fail still count
    assert call(hive_client, agent).status_code == 500
    assert call(hive_client, agent).status_code == 500
    bridge = use_bridge(hive, Bridge())
    third = call(hive_client, agent)
    assert third.status_code == 429 and third.json()["error"]["code"] == "subscription_daily_cap"
    assert bridge.seen == [] and usage_rows(hive_client, agent) == []
    hive.gateway.subscription_gate = SubscriptionGate(hive)   # a restarted gate reads the persisted attempts
    assert call(hive_client, agent).status_code == 429 and bridge.seen == []


@pytest.mark.parametrize("hive_client", ["0"], indirect=True)
def test_zero_cap_admits_none(hive_client):
    agent = owned_mind(hive_client)
    assert call(hive_client, agent).status_code == 429 and hive_client.bridge.seen == []


def test_provider_status_hides_the_bridge_key(hive_client):
    listed = hive_client.get("/api/providers").json()
    rows = listed if isinstance(listed, list) else listed.get("providers", [])
    row = next(r for r in rows if r["name"] == hive_client.sub.name)
    assert row["key_hint"] == "" and row["needs_key"] is False and hive_client.sub.key[-4:] not in json.dumps(listed)
    assert row["label"] == {CLI.name: "AI subscription (this Mac)", CODEX.name: "ChatGPT subscription (this Mac)"}[row["name"]]


def test_other_providers_unchanged_on_the_same_hive(hive_client):
    agent = owned_mind(hive_client)
    hive_client.hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (agent["id"],))
    assert call(hive_client, agent).status_code == 200
    (row,) = usage_rows(hive_client, agent)
    assert row["payer_mode"] is None and hive_client.bridge.seen == []


# ---- the Ask conductor, through its real path (Codex P1-2) --------------------------------------------------------

@pytest.fixture
def conducted(monkeypatch, sub):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", sub.model)
    with make_client(monkeypatch, sub) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        hive = test_client.app.state.hive
        owner, other = person(test_client, OWNER[5:], "admin"), person(test_client, OTHER[5:], "admin")
        set_owner(hive)
        swarm = test_client.post("/api/swarms", headers=owner, json={"name": "Owner home"}).json()
        coord = test_client.post("/api/agents", headers=owner, json={"name": "Orchestra", "swarm_id": swarm["id"]}).json()
        assert test_client.patch(f"/api/swarms/{swarm['id']}", json={"coordinator_id": coord["id"]}).status_code == 200
        hive.db.execute("UPDATE swarms SET owner = ?, visibility = 'private' WHERE id = ?", (OWNER, swarm["id"]))
        hive.db.execute("UPDATE agents SET owner = ?, status = 'awake', desired = 'awake' WHERE id = ?", (OWNER, coord["id"]))
        bridge = use_bridge(hive, Bridge())
        yield {"client": test_client, "hive": hive, "owner": owner, "other": other, "swarm": swarm, "coord": coord,
               "bridge": bridge, "model": sub.model}


def _conduct(w, headers, principal, op):
    from hive.tests.test_ask_conductor import closed, wait
    r = w["client"].post("/api/ask", headers=headers, json={"operation_id": op, "text": "invented question",
                                                           "context": {"swarm_id": w["swarm"]["id"]}})
    assert r.status_code == 202, r.text
    assert r.json().get("conductor") == {"model": w["model"]}
    return wait(w["hive"], op, closed, principal=principal)


def test_conductor_asked_by_another_person_on_owner_coordinator_is_refused(conducted):
    w = conducted
    fs = _conduct(w, w["other"], OTHER, "op-subcli-other-1")
    assert fs[-1]["phase"] in ("done", "refused") and fs[-1].get("outcome") != "complete", fs
    assert w["bridge"].seen == []
    assert w["hive"].db.all("SELECT * FROM usage WHERE payer_mode = 'plan'") == []


def test_conductor_asked_by_the_owner_uses_the_plan(conducted):
    w = conducted
    fs = _conduct(w, w["owner"], OWNER, "op-subcli-owner-1")
    assert fs[-1]["phase"] == "done" and fs[-1]["outcome"] == "complete", fs
    assert len(w["bridge"].sent) == 1
    (row,) = w["hive"].db.all("SELECT * FROM usage WHERE payer_mode = 'plan'")
    assert (row["payer"], row["cost_usd"]) == (OWNER, 0.0)


# ---- both instances on one hive (a Claude and a ChatGPT subscription together) ----------------------------------

def test_mixed_instances_keep_their_own_bridge_and_day_cap(monkeypatch):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    configure(monkeypatch, CODEX, cap=5)
    with make_client(monkeypatch, CLI, cap=1) as client:
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        client.headers["Authorization"] = f"Bearer {token}"
        client.hive, client.sub = client.app.state.hive, CLI
        set_owner(client.hive)
        bridge = use_bridge(client.hive, Bridge())
        claude, chatgpt = owned_mind(client), owned_mind(client, model=CODEX.model)
        assert call(client, claude).status_code == 200
        assert call(client, claude).status_code == 429          # subscription-cli's cap (1) is spent
        assert call(client, chatgpt).status_code == 200         # subscription-codex counts on its own
        assert [str(r.url).rsplit("/", 2)[0] for r in bridge.sent] == [CLI.bridge, CODEX.bridge]
        assert [json.loads(r.content)["model"] for r in bridge.sent] == [CLI.models[0], CODEX.models[0]]
        assert [r["authorization"] for r in (q.headers for q in bridge.sent)] == [f"Bearer {CLI.key}", f"Bearer {CODEX.key}"]
        gate = client.hive.gateway.subscription_gate
        assert (gate.attempts_today(CLI.name), gate.attempts_today(CODEX.name)) == (1, 1)   # the refused second call never counted
        rows = client.hive.db.all("SELECT model, payer_mode FROM usage WHERE payer_mode = 'plan' ORDER BY rowid")
        assert [r["model"] for r in rows] == [CLI.model, CODEX.model]


# ---- the attempts table: day-only key migrated to (provider, day) --------------------------------------------------

class _MigrationDB:
    """The hive DB's execute/one/all/transaction over a plain SQLite file (an old table written before the family)."""

    def __init__(self, path):
        import contextlib
        self.conn = sqlite3.connect(str(path), isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        @contextlib.contextmanager
        def transaction():
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
        self.transaction = transaction

    def execute(self, sql, params=()):
        return self.conn.execute(sql, params)

    def one(self, sql, params=()):
        row = self.conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql, params=()):
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]


def test_day_only_attempts_table_migrates_without_losing_a_count(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from hive.core.budgets import period_start
    path = tmp_path / "hive.db"
    old = sqlite3.connect(str(path))
    old.execute("CREATE TABLE subscription_cli_attempts (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)")
    today = period_start("day")
    old.executemany("INSERT INTO subscription_cli_attempts VALUES (?, ?)", [("2026-11-01T00:00:00+00:00", 9), (today, 3)])
    old.commit()
    old.close()
    db = _MigrationDB(path)
    gate = SubscriptionGate(SimpleNamespace(db=db))
    cols = [c["name"] for c in db.all("PRAGMA table_info(subscription_cli_attempts)")]
    assert cols == ["provider", "day", "calls"]
    assert [c["pk"] for c in db.all("PRAGMA table_info(subscription_cli_attempts)")] == [1, 2, 0]
    assert db.all("SELECT provider, day, calls FROM subscription_cli_attempts ORDER BY day") == [
        {"provider": CLI.name, "day": "2026-11-01T00:00:00+00:00", "calls": 9},
        {"provider": CLI.name, "day": today, "calls": 3}]
    assert db.one("SELECT name FROM sqlite_master WHERE name LIKE '%day_only%'") is None
    assert (gate.attempts_today(), gate.attempts_today(CODEX.name)) == (3, 0)   # today's count carried, codex fresh
    monkeypatch.setenv(CLI.env("DAILY_CALLS"), "4")
    gate._attempt(True, CLI.name)
    with pytest.raises(GatewayError) as full:
        gate._attempt(True, CLI.name)
    assert full.value.code == "subscription_daily_cap"
    gate._attempt(True, CODEX.name)
    assert (gate.attempts_today(CLI.name), gate.attempts_today(CODEX.name)) == (4, 1)
    SubscriptionGate(SimpleNamespace(db=db))   # a second start (or a second process) leaves it as it is
    assert db.one("SELECT COUNT(*) AS n FROM subscription_cli_attempts")["n"] == 3
