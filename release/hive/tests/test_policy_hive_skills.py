"""The hive-* default allow is bounded by a reviewed list (Kimi 2026-10-05)."""
import pathlib
import re

from hive.core import mcp, policy
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]


def defined_hive_skills():
    names = set()
    for toml in ROOT.glob("modules/*/module.toml"):
        names |= set(re.findall(r'"skill:(hive-[a-z0-9-]+)"', toml.read_text()))
    for skills in ROOT.glob("modules/*/skills.metta"):
        names |= set(re.findall(r"\(= \((hive-[a-z0-9-]+)", skills.read_text()))
    for core in ROOT.glob("hive/core/*.py"):                      # skills the host enforces directly
        names |= set(re.findall(r'(?:enforce|decide|_enforce)\([^)"]*"(hive-[a-z0-9-]+)"', core.read_text()))
    for value in mcp.POLICY.values():
        names |= {n for n in ((value,) if isinstance(value, str) else (value or ())) if n.startswith("hive-")}
    return names


def test_every_defined_hive_skill_has_been_reviewed():
    missing = sorted(defined_hive_skills() - policy.REVIEWED_HIVE_SKILLS - policy.EXPLICIT_ONLY)
    assert not missing, f"review these hive skills, then add them to policy.REVIEWED_HIVE_SKILLS: {missing}"


def test_an_unreviewed_hive_skill_asks_a_person(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P"}).json()
    mind = hive.create_agent("M", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert hive.policy.decide(mind, "hive-brand-new-disclosure")[0] == "ask"
    assert hive.policy.decide(mind, "hive-goal-claim")[0] == "allow"        # reviewed: unchanged


def test_explicit_only_skills_are_never_on_the_default_allow_list():
    assert not (policy.REVIEWED_HIVE_SKILLS & policy.EXPLICIT_ONLY)


def test_a_glob_allow_rule_cannot_allow_an_unreviewed_hive_skill(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P2"}).json()
    mind = hive.create_agent("M2", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.policy.add_rule(f"agent:{mind['id']}", "hive-*", "allow", "test")
    assert hive.policy.decide(mind, "hive-brand-new-disclosure")[0] == "ask"
    hive.policy.add_rule(f"agent:{mind['id']}", "hive-brand-new-disclosure", "allow", "exact")
    assert hive.policy.decide(mind, "hive-brand-new-disclosure")[0] == "allow"   # an exact rule is a review decision


def test_existing_exact_grant_skills_stay_exact_only(client):
    """OmegaReview 2026-10-05: hive-update-apply and hive-flow-publish keep their per-mind exact-grant boundary."""
    assert {"hive-update-apply", "hive-flow-publish"} <= policy.EXPLICIT_ONLY
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P3"}).json()
    mind = hive.create_agent("M3", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    for skill in ("hive-update-apply", "hive-flow-publish"):
        assert hive.policy.decide(mind, skill)[0] == "deny"


def test_the_reviewed_list_names_only_skills_that_exist():
    """Kimi 2026-10-05: a deleted skill re-added later must not inherit a review it never had."""
    stale = sorted(policy.REVIEWED_HIVE_SKILLS - defined_hive_skills())
    assert not stale, f"remove these from REVIEWED_HIVE_SKILLS, they are no longer defined: {stale}"


def test_the_definition_scan_still_sees_known_skills():
    """Kimi 2026-10-05: if the scan's patterns go deaf, fail loudly instead of passing everything."""
    found = defined_hive_skills()
    for sentinel in ("hive-goal-claim", "hive-publish", "hive-capabilities", "hive-asset-put", "hive-update-apply"):
        assert sentinel in found, sentinel
    assert len(found) >= 55


def test_a_skill_removed_from_the_reviewed_list_asks_again(client, monkeypatch):
    """Kimi 2026-10-05: the post-rules 'unreviewed -> ask' is the boundary; pin it for a removed name."""
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P4"}).json()
    mind = hive.create_agent("M4", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert hive.policy.decide(mind, "hive-goal-claim")[0] == "allow"
    monkeypatch.setattr(policy, "REVIEWED_HIVE_SKILLS", policy.REVIEWED_HIVE_SKILLS - {"hive-goal-claim"})
    assert hive.policy.decide(mind, "hive-goal-claim")[0] == "ask"


def test_the_review_boundaries_cannot_be_changed_at_runtime():
    """Kimi 2026-10-05: a mutable set could be edited by a plugin or refactor without any test noticing."""
    assert isinstance(policy.REVIEWED_HIVE_SKILLS, frozenset) and isinstance(policy.EXPLICIT_ONLY, frozenset)
