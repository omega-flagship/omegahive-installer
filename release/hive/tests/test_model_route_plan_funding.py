"""A settled owner-plan route (any subscription instance: subscription-cli, subscription-codex) is a funded Foundation
route; nothing else changes."""
import pytest

from hive.core import model_route
from hive.core.config import SUBSCRIPTION_CLI, SUBSCRIPTION_CODEX

PLAN_MODELS = (f"{SUBSCRIPTION_CLI}/claude-cli-sonnet-5-5", f"{SUBSCRIPTION_CODEX}/codex-cli-gpt-6.1-sol")


class _Provider:
    def __init__(self, local=False, prices=()):
        self.local, self._prices = local, set(prices)

    def priced(self, name):
        return name in self._prices


class _Store:
    providers = {SUBSCRIPTION_CLI: None, SUBSCRIPTION_CODEX: None, "openrouter": None}

    def __init__(self):
        self._p = {SUBSCRIPTION_CLI: _Provider(), SUBSCRIPTION_CODEX: _Provider(),
                   "openrouter": _Provider(prices={"priced/x"})}

    def provider(self, name):
        return self._p[name]


def _facts(model, settled):
    return model_route.facts([model], _Store(), None, settle=lambda m: settled, foundation=True)


@pytest.mark.parametrize("plan_model", PLAN_MODELS)
def test_settled_plan_counts_as_funded_for_foundation(plan_model):
    f = _facts(plan_model,
               {"payer_mode": "plan", "bounded": True, "own_key": True, "host_paid": False})
    need = next(n for n, p in model_route.NEEDS.items() if p == "foundation-funded")
    assert model_route.rule(need, f) is f[0]


@pytest.mark.parametrize("plan_model", PLAN_MODELS)
def test_unsettled_or_unbounded_plan_is_not_funded(plan_model):
    need = next(n for n, p in model_route.NEEDS.items() if p == "foundation-funded")
    for settled in ({"reason": "subscription_owner_only"}, {"payer_mode": "plan", "bounded": False}, {}):
        assert model_route.rule(need, _facts(plan_model, settled)) is None


@pytest.mark.parametrize("plan_model", PLAN_MODELS)
def test_plan_never_satisfies_the_host_paid_personal_rule(plan_model):
    f = model_route.facts([plan_model], _Store(), None,
                          settle=lambda m: {"payer_mode": "plan", "bounded": True, "host_paid": False})
    for need, policy in model_route.NEEDS.items():
        if policy not in ("foundation-funded", "configured"):
            assert model_route.rule(need, f) is None
