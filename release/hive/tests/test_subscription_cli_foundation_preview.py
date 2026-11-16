"""The Foundation helper preview (a not-yet-made child, id "") may settle on the owner's plan; it never dispatches.
Every test runs for each subscription instance (subscription-cli, subscription-codex)."""
import json
from types import SimpleNamespace

import pytest

from hive.core import subscription_cli as sc
from hive.core.config import SUBSCRIPTIONS
from hive.core.gateway import GatewayError

OWNER = "user:u_owner"
CODE = "s_code"


class _DB:
    def __init__(self, swarms, agents):
        self.swarms, self.agents = swarms, agents

    def execute(self, *a, **k):
        return None

    def one(self, sql, args=()):
        if "FROM swarms" in sql:
            return self.swarms.get(args[0])
        if "FROM agents" in sql:
            return next((a for a in self.agents if a["id"] == args[0]), None)
        if "subscription_cli_attempts" in sql:
            return None
        return None

    def all(self, sql, args=()):
        if sql.startswith("PRAGMA"):
            return []
        return [{"owner": a["owner"]} for a in self.agents if a["swarm_id"] == args[0]]


@pytest.fixture(params=list(SUBSCRIPTIONS))
def sub(request, monkeypatch):
    for prefix in SUBSCRIPTIONS.values():
        monkeypatch.delenv(f"{prefix}_SWARMS", raising=False)
    return request.param


def _gate(monkeypatch, sub, owner=OWNER):
    monkeypatch.setenv("HIVE_HOST", "127.0.0.1")
    monkeypatch.setenv(f"{SUBSCRIPTIONS[sub]}_SWARMS", json.dumps([CODE]))
    provider = SimpleNamespace(local=False, base_url="http://127.0.0.1:8011/v1")
    hive = SimpleNamespace(
        settings=SimpleNamespace(providers={sub: provider}),
        ownhive=SimpleNamespace(owner=lambda: owner),
        db=_DB({CODE: {"id": CODE, "owner": OWNER, "visibility": "public", "archived_at": None}},
               [{"id": "a_ctl", "owner": OWNER, "swarm_id": CODE, "deleted": 0}]),
        user_for=lambda m: OWNER)
    return sc.SubscriptionGate(hive)


def _child(**over):
    return dict({"id": "", "owner": OWNER, "swarm_id": CODE, "_foundation_preview": True}, **over)


def test_preview_admitted_for_owner_child_in_opted_in_swarm(monkeypatch, sub):
    _gate(monkeypatch, sub).authorize(_child(), principal=OWNER, preview=True, provider=sub)


def test_preview_needs_this_instances_own_opt_in_and_provider(monkeypatch, sub):
    other = next(n for n in SUBSCRIPTIONS if n != sub)
    gate = _gate(monkeypatch, sub)
    with pytest.raises(GatewayError):   # the other instance: not configured on this hive, nor opted in
        gate.authorize(_child(), principal=OWNER, preview=True, provider=other)
    monkeypatch.delenv(f"{SUBSCRIPTIONS[sub]}_SWARMS")
    monkeypatch.setenv(f"{SUBSCRIPTIONS[other]}_SWARMS", json.dumps([CODE]))
    with pytest.raises(GatewayError):   # another instance's opt-in does not open this one
        gate.authorize(_child(), principal=OWNER, preview=True, provider=sub)


@pytest.mark.parametrize("child,principal", [
    (_child(), "user:u_other"),                       # someone else's call
    (_child(), None),                                 # the caller must name the owner
    (_child(owner="user:u_other"), OWNER),            # not the owner's child
    (_child(_foundation_preview=False), OWNER),       # unmarked empty id falls to _chain: refused
    (_child(swarm_id="s_unlisted"), OWNER),           # swarm unknown / not in scope
])
def test_preview_refusals(monkeypatch, sub, child, principal):
    with pytest.raises(GatewayError):
        _gate(monkeypatch, sub).authorize(child, principal=principal, preview=True, provider=sub)


def test_preview_never_dispatches(monkeypatch, sub):
    gate = _gate(monkeypatch, sub)
    with pytest.raises(GatewayError):
        gate.admit(_child(), principal=OWNER, dispatch=True, provider=sub)
    with pytest.raises(GatewayError):
        gate.authorize(_child(), principal=OWNER, provider=sub)          # send-boundary recheck (preview=False) refuses too
