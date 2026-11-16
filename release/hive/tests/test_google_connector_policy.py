"""Calendar owner consent is a prerequisite, never something a generic policy can grant."""

from types import SimpleNamespace

import pytest

from hive.core.policy import Policy


AGENT = {"id": "a_calendar", "owner": "user:u_calendar", "name": "Calendar reader", "swarm_id": "s_calendar"}


class RuleRows:
    def __init__(self, rules=()):
        self.rows = list(rules)

    def all(self, sql, args=()):
        assert "policy_rules" in sql
        return self.rows


class Consent:
    def __init__(self, allowed=False):
        self.allowed = allowed
        self.calls = []

    def mind_allowed(self, agent):
        self.calls.append(dict(agent))
        if isinstance(self.allowed, Exception):
            raise self.allowed
        return self.allowed


def rule(skill, mode, scope="agent:a_calendar"):
    return {"scope": scope, "skill": skill, "mode": mode, "note": "synthetic rule", "created_at": "2026-10-26T00:00:00Z"}


def engine(allowed=False, rules=(), ceiling=None):
    connector = Consent(allowed)
    hive = SimpleNamespace(db=RuleRows(rules), google_connector=connector,
                           person_swarms=SimpleNamespace(ceiling=lambda agent_id, skill: ceiling))
    return Policy(hive), connector


@pytest.mark.parametrize("rules", [(), (rule("*", "allow", "hive"),),
                                  (rule("calendar-*", "allow"),), (rule("calendar-read", "allow"),)])
def test_no_default_glob_or_exact_rule_can_supply_missing_person_consent(rules):
    policy, connector = engine(False, rules)
    assert policy.decide(AGENT, "calendar-read")[0] == "deny"
    assert connector.calls == [AGENT]


@pytest.mark.parametrize("value", [False, None, 1, "allow", {"connected": True}, RuntimeError("unavailable")])
def test_unavailable_or_non_boolean_consent_fails_closed(value):
    policy, _ = engine(value, [rule("calendar-read", "allow")])
    assert policy.decide(AGENT, "calendar-read")[0] == "deny"


def test_missing_connector_fails_closed_during_startup_or_unavailability():
    policy, _ = engine(True)
    del policy.hive.google_connector
    assert policy.decide(AGENT, "calendar-read")[0] == "deny"


def test_exact_live_consent_allows_normal_policy_to_decide():
    policy, connector = engine(True)
    assert policy.decide(AGENT, "calendar-read") == ("allow", "default")
    assert connector.calls == [AGENT]


@pytest.mark.parametrize("mode", ["deny", "ask"])
def test_existing_rules_can_only_tighten_live_consent(mode):
    policy, _ = engine(True, [rule("calendar-read", mode)])
    assert policy.decide(AGENT, "calendar-read")[0] == mode


@pytest.mark.parametrize("ceiling", ["deny", "ask"])
def test_app_template_ceiling_still_tightens_live_consent(ceiling):
    policy, _ = engine(True, [rule("calendar-read", "allow")], ceiling)
    assert policy.decide(AGENT, "calendar-read")[0] == ceiling


def test_every_decision_rechecks_revoked_consent_instead_of_caching_allow():
    policy, connector = engine(True, [rule("calendar-read", "allow")])
    assert policy.decide(AGENT, "calendar-read")[0] == "allow"
    connector.allowed = False
    assert policy.decide(AGENT, "calendar-read")[0] == "deny"
    assert len(connector.calls) == 2


def test_calendar_requirement_does_not_change_an_unrelated_skill():
    policy, connector = engine(RuntimeError("must not be called"))
    assert policy.decide(AGENT, "read-file") == ("allow", "default")
    assert connector.calls == []
