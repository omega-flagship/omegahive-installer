"""What is left of each plan (subscription_cli.PlanReader / subscription_status, GET /api/subscriptions/status): the
bridge's own plan reading beside the hive's day guard, for the hive owner only; anything unreadable is unknown.

Synthetic only: a fake bridge transport, invented ids, an invented bridge key and invented numbers; no network, no CLI."""

import json
import pathlib

import httpx
import pytest

from hive.core import subscription_cli
from hive.core.subscription_cli import PlanReader, plan_reading
from hive.tests.test_subscription_cli_route import (CLI, CODEX, OWNER, PETTA, call, clean_env, configure,  # noqa: F401
                                                    hive_client, owned_mind, sub)
from hive.tests.test_visibility import person

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

NOW = 1794400000
CLAUDE_READING = {"object": "plan_status", "provider": "claude", "plan_type": "max", "status": "allowed",
                  "windows": [{"name": "seven_day", "used_fraction": 0.53, "resets_at": 1794589200},
                              {"name": "five_hour", "used_fraction": 0.2, "resets_at": NOW - 10}],   # already reset
                  "overage": {"status": "rejected", "in_use": False, "disabled_reason": "org_level_disabled"},
                  "credits": None, "observed_at": NOW - 30, "prompt": "PROMPT-CANARY"}
CODEX_READING = {"object": "plan_status", "provider": "codex", "plan_type": "promax", "status": None,
                 "windows": [{"name": "seven_day", "used_fraction": 1.0, "resets_at": 1794489818}],
                 "overage": None, "credits": {"has_credits": True, "unlimited": False, "balance": 4873.24},
                 "observed_at": NOW - 30}
READINGS = {CLI.name: CLAUDE_READING, CODEX.name: CODEX_READING}


class PlanBridge(httpx.BaseTransport):
    def __init__(self, answer=None, status=200, exc=None):
        self.answer, self.status, self.exc, self.seen = answer, status, exc, []

    def handle_request(self, request):
        self.seen.append(request)
        if self.exc is not None:
            raise self.exc("invented failure", request=request)
        return httpx.Response(self.status, json=self.answer)


class Clock:
    def __init__(self):
        self.now = 500.0

    def __call__(self):
        return self.now


def use_plan_bridge(client, transport):
    reader = client.hive.gateway.subscription_gate.plan_reader
    reader.transport, reader._cache = transport, {}
    return transport


def owner_headers(client):
    return person(client, OWNER.split(":", 1)[1], role="admin")


def test_owner_sees_provider_reading_beside_the_hive_guard(hive_client, monkeypatch):
    monkeypatch.setattr(subscription_cli.time, "time", lambda: NOW)
    bridge = use_plan_bridge(hive_client, PlanBridge(READINGS[hive_client.sub.name]))
    agent = owned_mind(hive_client)
    assert call(hive_client, agent).status_code == 200   # one counted hive call today
    body = hive_client.get("/api/subscriptions/status", headers=owner_headers(hive_client)).json()
    (row,) = body["subscriptions"]
    assert row["provider"] == hive_client.sub.name and row["reported"] is True
    assert row["hive_calls_today"] == 1 and row["hive_daily_cap"] == 500 and row["hive_resets_at"].endswith("T00:00:00Z")
    if hive_client.sub is CLI:
        assert row["vendor"] == "claude" and row["plan_type"] == "max" and row["status"] == "allowed"
        assert row["windows"] == [{"name": "seven_day", "used_fraction": 0.53, "resets_at": 1794589200}]
        assert row["overage"]["status"] == "rejected" and row["credits"] is None
    else:
        assert row["vendor"] == "codex" and row["plan_type"] == "promax" and row["status"] == "reported"
        assert row["credits"] == {"has_credits": True, "unlimited": False, "balance": 4873.24}
    assert "PROMPT-CANARY" not in json.dumps(body)
    (request,) = bridge.seen
    assert str(request.url) == hive_client.sub.bridge + "/plan-status"
    assert request.headers["Authorization"] == f"Bearer {hive_client.sub.key}"
    assert hive_client.sub.key not in json.dumps(body)


@pytest.mark.parametrize("who", ["operator", "member", "admin"])
def test_nobody_but_the_owner_sees_any_of_it(hive_client, who):
    bridge = use_plan_bridge(hive_client, PlanBridge(READINGS[hive_client.sub.name]))
    headers = {} if who == "operator" else person(hive_client, f"u_{who}0001", role=who)
    body = hive_client.get("/api/subscriptions/status", headers=headers).json()
    assert body == {"subscriptions": []} and bridge.seen == []   # not even which plans are attached; no fetch


@pytest.mark.parametrize("bridge", [PlanBridge(exc=httpx.ConnectError), PlanBridge(exc=httpx.ReadTimeout),
                                    PlanBridge({"error": "x"}, status=500), PlanBridge("not an object"),
                                    PlanBridge(dict(CLAUDE_READING, provider="someone-else")),
                                    PlanBridge(dict(CLAUDE_READING, observed_at=None))])
def test_bridge_down_or_odd_is_unknown_never_an_error(hive_client, bridge):
    use_plan_bridge(hive_client, bridge)
    answer = hive_client.get("/api/subscriptions/status", headers=owner_headers(hive_client))
    assert answer.status_code == 200
    (row,) = answer.json()["subscriptions"]
    assert row["status"] == "unknown" and row["reported"] is False and row["windows"] == [] and row["credits"] is None
    assert row["hive_daily_cap"] == 500


def test_reading_is_cached_for_a_minute():
    clock, bridge = Clock(), PlanBridge(CLAUDE_READING)
    provider = type("P", (), {"local": False, "base_url": "http://127.0.0.1:8791/v1", "api_key": "invented-key"})()
    reader = PlanReader(lambda name: provider, clock=clock, transport=bridge)
    assert reader.read(CLI.name, now=NOW)["plan_type"] == "max"
    clock.now += 30
    reader.read(CLI.name, now=NOW)
    assert len(bridge.seen) == 1
    clock.now += 31
    reader.read(CLI.name, now=NOW)
    assert len(bridge.seen) == 2


def test_never_fetched_off_loopback_or_without_a_key():
    bridge = PlanBridge(CLAUDE_READING)
    for base, key in (("http://192.168.1.5:8791/v1", "k"), ("http://localhost:8791/v1", "k"),
                      ("http://127.0.0.1:8791/v1", "")):
        provider = type("P", (), {"local": False, "base_url": base, "api_key": key})()
        assert PlanReader(lambda name: provider, transport=bridge).read(CLI.name) is None
    assert PlanReader(lambda name: None, transport=bridge).read("openrouter") is None
    assert bridge.seen == []


def test_reading_fields_are_rechecked():
    odd = dict(CLAUDE_READING, plan_type="max; rm -rf", status=["x"],
               windows=[{"name": "Seven Day!", "used_fraction": 0.5, "resets_at": NOW + 99},
                        {"name": "seven_day", "used_fraction": "half", "resets_at": NOW + 99},
                        {"name": "seven_day", "used_fraction": True, "resets_at": NOW + 99},
                        {"name": "one_day", "used_fraction": 0.25, "resets_at": "soon"}],
               credits={"has_credits": "yes", "balance": "4873.24"})
    reading = plan_reading(odd, "claude", now=NOW)
    assert reading["plan_type"] is None and reading["status"] == "reported"
    assert reading["windows"] == [{"name": "one_day", "used_fraction": 0.25, "resets_at": None}]
    assert reading["credits"] == {"has_credits": None, "unlimited": None, "balance": None}
    assert set(reading) == {"plan_type", "status", "windows", "overage", "credits", "observed_at"}
