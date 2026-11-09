"""A subscription bridge that is down must not burn the day's cap (subscription_cli.py: SubscriptionGate.release and the
bridge cooldown; gateway.py: Gateway.subscription_transport_failed). A dispatch whose transport never connected is
released; anything that may have reached the bridge still counts; an unreachable bridge is refused 503
subscription_bridge_down for a cooldown, per instance, without counting.

Synthetic only: fake bridge transports, invented ids and keys, a fake clock; no network, no CLI."""

import pathlib

import httpx
import pytest

from hive.core import subscription_cli
from hive.core.subscription_cli import SubscriptionGate
from hive.tests.test_subscription_cli_route import (CLI, CODEX, PETTA, Bridge, call, clean_env, configure,  # noqa: F401
                                                    hive_client, make_client, owned_mind, set_owner, sub, use_bridge,
                                                    usage_rows)

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class DeadBridge(Bridge):
    """Connection refused: raises before the send boundary, as httpcore does when nothing listens."""

    async def handle_async_request(self, request):
        self.seen.append(request)
        raise httpx.ConnectError("All connection attempts failed", request=request)


class SentThenFails(Bridge):
    """Connected and the request written (the send boundary reached), then the transport fails: it may have arrived."""

    def __init__(self, exc):
        super().__init__()
        self.exc = exc

    async def handle_async_request(self, request):
        self.seen.append(request)
        await request.extensions["trace"]("http11.send_request_headers.started", {})
        self.sent.append(request)
        raise self.exc("invented failure", request=request)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def failed(client, agent):
    """A transport failure: this route lets it propagate (the test client re-raises it; uvicorn answers 500)."""
    with pytest.raises(httpx.TransportError):
        call(client, agent)
    return True


def fresh_gate(client):
    clock = Clock()
    client.hive.gateway.subscription_gate = SubscriptionGate(client.hive, clock=clock)
    return client.hive.gateway.subscription_gate, clock


def test_connect_refused_is_not_counted_and_starts_a_cooldown(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    dead = use_bridge(hive_client.hive, DeadBridge())
    assert failed(hive_client, agent) and len(dead.seen) == 1
    assert gate.attempts_today(name) == 0                 # released: it never reached the bridge
    assert gate.bridge_cooldown(name) == subscription_cli.BRIDGE_COOLDOWN_FIRST
    # inside the cooldown: refused quickly, before the transport, and not counted
    for _ in range(5):
        refused = call(hive_client, agent)
        assert refused.status_code == 503 and refused.json()["error"]["code"] == "subscription_bridge_down"
    assert len(dead.seen) == 1 and gate.attempts_today(name) == 0 and usage_rows(hive_client, agent) == []


def test_cooldown_ends_and_a_reached_bridge_clears_it(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    use_bridge(hive_client.hive, DeadBridge())
    failed(hive_client, agent)
    clock.now += subscription_cli.BRIDGE_COOLDOWN_FIRST + 1
    live = use_bridge(hive_client.hive, Bridge())          # the bridge is back
    assert call(hive_client, agent).status_code == 200 and len(live.sent) == 1
    assert gate.attempts_today(name) == 1 and gate.bridge_cooldown(name) == 0
    # cleared: the next outage starts again from the first step
    use_bridge(hive_client.hive, DeadBridge())
    failed(hive_client, agent)
    assert gate.bridge_cooldown(name) == subscription_cli.BRIDGE_COOLDOWN_FIRST and gate.attempts_today(name) == 1


def test_cooldown_doubles_to_the_max_while_down(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    dead = use_bridge(hive_client.hive, DeadBridge())
    seen = []
    for _ in range(6):
        failed(hive_client, agent)
        seen.append(gate.bridge_cooldown(name))
        clock.now += seen[-1] + 1
    assert seen == [60.0, 120.0, 240.0, 480.0, 600.0, 600.0]
    assert len(dead.seen) == 6 and gate.attempts_today(name) == 0


def test_failure_inside_a_running_cooldown_does_not_lengthen_it(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    gate.bridge_down(name)
    clock.now += 10
    gate.bridge_down(name)                                 # a call that was already in flight fails too
    assert gate.bridge_cooldown(name) == subscription_cli.BRIDGE_COOLDOWN_FIRST - 10


@pytest.mark.parametrize("exc", [httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError, httpx.ConnectError])
def test_failure_after_the_send_boundary_still_counts(hive_client, exc):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    bridge = use_bridge(hive_client.hive, SentThenFails(exc))
    assert failed(hive_client, agent) and len(bridge.sent) == 1
    assert gate.attempts_today(name) == 1                 # it may have reached the bridge: counted
    assert gate.bridge_cooldown(name) == 0                 # and the bridge was up


def test_http_answer_counts_and_clears_a_cooldown(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    gate.bridge_down(name)
    clock.now += subscription_cli.BRIDGE_COOLDOWN_FIRST
    use_bridge(hive_client.hive, Bridge(status=500, answer={"error": "invented"}))
    assert call(hive_client, agent).status_code == 500
    assert gate.attempts_today(name) == 1 and gate.bridge_cooldown(name) == 0


@pytest.mark.parametrize("hive_client", [1], indirect=True)
def test_released_attempt_frees_room_under_the_cap_and_survives_a_restart(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    agent = owned_mind(hive_client)
    use_bridge(hive_client.hive, DeadBridge())
    for _ in range(3):                                     # a retrying mind across three cooldowns
        failed(hive_client, agent)
        clock.now += subscription_cli.BRIDGE_COOLDOWN_MAX + 1
    restarted = SubscriptionGate(hive_client.hive)         # persisted count: nothing; cooldown: in-process only
    hive_client.hive.gateway.subscription_gate = restarted
    assert restarted.attempts_today(name) == 0 and restarted.bridge_cooldown(name) == 0
    use_bridge(hive_client.hive, Bridge())
    assert call(hive_client, agent).status_code == 200     # the cap of 1 is still there to use
    capped = call(hive_client, agent)
    assert capped.status_code == 429 and capped.json()["error"]["code"] == "subscription_daily_cap"


def test_release_never_goes_below_zero_or_touches_another_day(hive_client):
    gate, clock = fresh_gate(hive_client)
    name = hive_client.sub.name
    gate.release(name, "2026-11-07T00:00:00Z")
    gate.release(name, None)
    db = hive_client.hive.db
    assert db.all("SELECT * FROM subscription_cli_attempts") == []
    db.execute("INSERT INTO subscription_cli_attempts (provider, day, calls) VALUES (?, ?, 0)",
               (name, "2026-11-07T00:00:00Z"))
    gate.release(name, "2026-11-07T00:00:00Z")
    assert db.one("SELECT calls FROM subscription_cli_attempts WHERE provider = ?", (name,))["calls"] == 0


def test_bridge_down_is_per_instance(monkeypatch):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    configure(monkeypatch, CODEX)
    with make_client(monkeypatch, CLI) as client:
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        client.headers["Authorization"] = f"Bearer {token}"
        client.hive, client.sub = client.app.state.hive, CLI
        set_owner(client.hive)
        gate, clock = fresh_gate(client)
        claude, chatgpt = owned_mind(client), owned_mind(client, model=CODEX.model)

        class OneDead(Bridge):   # the Claude bridge is down, the ChatGPT bridge is up
            async def handle_async_request(self, request):
                if str(request.url).startswith(CLI.bridge):
                    self.seen.append(request)
                    raise httpx.ConnectError("All connection attempts failed", request=request)
                return await super().handle_async_request(request)

        bridge = use_bridge(client.hive, OneDead())
        assert failed(client, claude)
        assert call(client, claude).json()["error"]["code"] == "subscription_bridge_down"
        assert call(client, chatgpt).status_code == 200
        assert gate.bridge_cooldown(CLI.name) > 0 and gate.bridge_cooldown(CODEX.name) == 0
        assert (gate.attempts_today(CLI.name), gate.attempts_today(CODEX.name)) == (0, 1)
        assert [str(r.url).rsplit("/", 2)[0] for r in bridge.sent] == [CODEX.bridge]
