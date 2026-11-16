"""Purpose: verify hive worker prompt discovery and Omega task protocol tools.

Mind fitness fix 2 (2026-10-06): minds on the hive channel get a hive-worker base prompt.

Every hive mind used to sit on the personal-Omega base (WhatsApp, primary operator, energy, "No JSON") although the
hive's review and artifact skills take JSON. The hive base has a protocol block with one exact example per step;
each example is parsed by the real command parser and dry-validated against the hive's own checks here."""
import importlib.util
import json
import pathlib
import re
import sys

import pytest

from hive.core import collab, result_schema
from hive.core.config import load_settings
from hive.core.policy import REVIEWED_HIVE_SKILLS
from hive.supervisor import workspace as ws

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from hive.runtime.extensions import helper_command_parser as parser  # noqa: E402

_spec = importlib.util.spec_from_file_location("hive_commons_prompt", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

PROTOCOL = ["hive-goals", "hive-goal-get", "hive-goal-claim", "hive-goal-heartbeat", "hive-finding",
            "hive-review-complete", "hive-goal-propose", "hive-goal-done"]
# A result schema of the kind a Qwello research goal carries; the propose example must fit it.
ANSWER_SCHEMA = {"type": "object", "required": ["answer", "sources"], "additionalProperties": False,
                 "properties": {"answer": {"type": "string", "maxLength": 2000},
                                "sources": {"type": "array", "items": {"type": "string"}, "minItems": 1}}}


def _workspace(tmp_path):
    return ws.Workspace(load_settings(data_dir=tmp_path / "hive", admin_password="pw"))


def _examples():
    text = ws.HIVE_BASE_PROMPT.read_text(encoding="utf-8")
    block = text[text.index("Hive protocol"):text.index("If the hive refuses")]
    return [line[2:].strip() for line in block.splitlines() if line.startswith("- hive-")]


def _args(parsed):
    """The string arguments of one parsed command '(head "a" "b")'."""
    return [json.loads('"' + a + '"') for a in re.findall(r'"((?:[^"\\]|\\.)*)"', parsed)]


def test_a_hive_mind_gets_the_hive_base_with_its_role_and_no_personal_sections(tmp_path):
    w = _workspace(tmp_path)
    agent = {"id": "a_fit1", "name": "Lyra", "kind": "omega", "role_prompt": "You review plans for security.", "persona": "Calm."}
    w.write_prompt(agent)
    text = (w.path("a_fit1") / "memory" / "prompt.txt").read_text(encoding="utf-8")
    assert text.startswith("You are Lyra, a mind in an OmegaHive swarm")
    assert "Hive protocol" in text and "## Your role\nYou review plans for security." in text and "## Also\nCalm." in text
    assert "## You are Lyra, a mind in an OmegaHive" in text          # the existing hive block still follows
    for personal in ("WhatsApp", "primary operator", "send-control-base64", "energy-status", "No JSON, code blocks"):
        assert personal not in text, personal
    assert "{name}" not in text and "No JSON, except as the argument of a skill that takes {json}" in text


def test_the_personal_base_is_unchanged_and_used_when_the_hive_base_is_absent(tmp_path, monkeypatch):
    w = _workspace(tmp_path)
    core = w.settings.core_root
    # A local memory/prompt.txt overrides the shipped seed, src/base_prompt.txt; a clean checkout has only the seed.
    seed = next(p for p in (core / "memory" / "prompt.txt", core / "src" / "base_prompt.txt") if p.exists())
    personal = seed.read_text(encoding="utf-8")
    assert w.base_prompt() == personal and "WhatsApp" in personal
    monkeypatch.setattr(ws, "HIVE_BASE_PROMPT", tmp_path / "missing.txt")
    assert w.mind_base_prompt({"name": "Orion"}) == personal.replace("Omega", "Orion")


def test_the_protocol_block_has_one_example_for_each_step_in_order():
    heads = [line.split()[0] for line in _examples()]
    assert heads == PROTOCOL


def test_every_example_parses_as_its_own_skill_and_its_json_passes_the_hives_checks():
    seen = {}
    for line in _examples():
        head = line.split()[0]
        parsed = parser.signature_balance_parentheses(line)
        assert parsed.startswith(f"(({head}") or parsed.startswith(f"({head}"), (line, parsed)
        inner = parsed[1:-1] if parsed.startswith("((") else parsed
        assert "syntax-error" not in inner and not inner.startswith("(wait"), (line, parsed)
        assert len(parser.SIGNATURE_COMMANDS[head]) == len(_args(inner)), (line, inner)
        seen[head] = _args(inner)
    assert collab.finding_shape_problems(json.loads(seen["hive-finding"][0])) == []
    request_id, review = seen["hive-review-complete"]
    assert request_id.startswith("rq_") and collab.review_shape_problems(json.loads(review)) == []
    goal, proposal = seen["hive-goal-propose"]
    assert goal.startswith("g_") and result_schema.validate(json.loads(proposal), ANSWER_SCHEMA) == []
    assert seen["hive-goal-heartbeat"] == ["g_1a2b3c4d"] and seen["hive-goals"] == []
    assert ";" not in "".join(_examples())   # a ';' would start a MeTTa comment in a command


def test_a_wrong_example_fails_the_same_checks():
    """Baseline-negative for the checks above: the shapes the 2026-10-04 trial actually sent are refused."""
    assert collab.finding_shape_problems({"finding_id": "x", "severity": "critical", "title": "t", "evidence": ["e"]})
    assert collab.review_shape_problems({"recommendation": "request changes", "rationale": ""}) == [
        "recommendation is one of: proceed, revise, hold, unresolved", "rationale is text of at most 4000 characters"]
    assert result_schema.validate({"text": "an answer"}, ANSWER_SCHEMA)


def test_heartbeat_is_a_real_reviewed_omega_skill(monkeypatch):
    for path, needle in ((ROOT / "modules/hive/signatures.metta", "(SkillSignature hive-goal-heartbeat (Arg text goal))"),
                         (ROOT / "modules/hive/skills.metta", "(py-call (hive_commons.goal_heartbeat $id))"),
                         (ROOT / "modules/hive/entry.metta", "(Provides omegaclaw.hive.commons (Skill hive-goal-heartbeat))"),
                         (ROOT / "modules/hive/module.toml", '"skill:hive-goal-heartbeat"'),
                         (ROOT / "modules/hive/catalog.metta", '(SkillHelp "hive-goal-heartbeat"')):
        assert needle in path.read_text(encoding="utf-8"), path
    assert "hive-goal-heartbeat" in REVIEWED_HIVE_SKILLS and "goal_heartbeat" in hc.SKILLS
    sent = []
    monkeypatch.setattr(hc, "_call", lambda m, p, payload=None: (sent.append((m, p)) or
                                                                {"id": "g_1", "status": "claimed", "lease_until": "2026-10-06T12:00:00Z"}, None))
    assert hc.goal_heartbeat("g_1") == "HIVE-GOAL-HEARTBEAT g_1 claimed lease_until=2026-10-06T12:00:00Z"
    assert sent == [("POST", "/api/agent/goals/g_1/heartbeat")]


def test_hive_goals_lists_the_minds_own_goals_first(monkeypatch):
    monkeypatch.setenv("HIVE_AGENT_ID", "a_me")
    goals = {"claimed": [{"id": "g_held", "status": "claimed", "priority": 0.5, "title": "mine", "claimed_by": "a_me"},
                         {"id": "g_other", "status": "claimed", "priority": 0.9, "title": "theirs", "claimed_by": "a_x"}],
             "waiting": [],
             "open": [{"id": "g_for_me", "status": "open", "priority": 0.4, "title": "assigned", "assignee": "a_me"},
                      {"id": "g_free", "status": "open", "priority": 0.7, "title": "free"}]}
    # goals also asks which people's messages the mind owes an answer (replies.py), none here, and its done history
    monkeypatch.setattr(hc, "_call", lambda m, p, payload=None: ({"owed": []}, None) if p == "/api/agent/replies/owed"
                        else ({"goals": [], "next_offset": None}, None) if p.endswith("/history")
                        else (goals[p.split("status=")[1]], None))
    out = hc.goals()
    assert out == ("HIVE-GOALS yours: g_held claimed p=0.50 mine | g_for_me open p=0.40 assigned"
                   " || open: g_free p=0.70 free || done: none (hive-goal-history searches older work)")


def test_every_commons_statement_the_prompt_shows_is_one_the_commons_accepts(tmp_path):
    # The prompt said a statement is any MeTTa expression after the commons began to accept only logical forms, so a
    # mind's first share, (--> (boiling-point water sea-level) (celsius 100)), was refused (omegahive-feedback#113).
    # It now states the rule from the commons' own connectives, and each statement it shows passes the commons' check.
    from hive.spaces import sexpr
    w = _workspace(tmp_path)
    w.write_prompt({"id": "a_pub1", "name": "Lyra", "kind": "omega"})
    text = (w.path("a_pub1") / "memory" / "prompt.txt").read_text(encoding="utf-8")
    assert "every list in it starts with one of " + " ".join(sorted(sexpr.STATEMENT_HEADS)) in text
    block = text[text.index("- `hive-publish"):text.index("- `hive-query")]
    shown = [s[len("hive-publish "):].rsplit(" ", 2)[0] if s.startswith("hive-publish (") else s
             for s in re.findall(r"`([^`]*\([^`]*)`", block)]
    assert shown == ["(--> sky blue)", "(--> (x water sea-level) boils-at-100-celsius)"]
    for statement in shown:
        assert sexpr.safe_commons_statement(statement) == statement
    with pytest.raises(sexpr.SexprError):   # the form minds wrote before: the rule stated is the rule held
        sexpr.safe_commons_statement("(--> (boiling-point water sea-level) (celsius 100))")


def test_a_persons_own_mind_is_told_it_is_alone_and_what_its_shares_reach(tmp_path):
    # A person's own mind lives alone in a swarm of its own (hive/core/personal.py). Told nothing of it, on v0.31 one
    # exhibited a lesson to its empty swarm and was refused, and others published one and told their person that other
    # minds or swarm-mates could read it. Its prompt now says it is alone and who reads what it shares. Any other
    # mind's prompt is unchanged.
    w = _workspace(tmp_path)
    w.write_prompt({"id": "a_own1", "name": "Fern", "kind": "omega", "personal": True})
    w.write_prompt({"id": "a_team1", "name": "Fern", "kind": "omega", "personal": False})
    own = (w.path("a_own1") / "memory" / "prompt.txt").read_text(encoding="utf-8")
    team = (w.path("a_team1") / "memory" / "prompt.txt").read_text(encoding="utf-8")
    assert own.endswith(ws.OWN_MIND_PROMPT) and ws.OWN_MIND_PROMPT not in team
    assert own[:-len(ws.OWN_MIND_PROMPT)] == team   # the same mind otherwise: only the block is added
    block = " ".join(ws.OWN_MIND_PROMPT.split())
    assert "## You are your person's own mind" in block
    assert "No other mind is in your swarm or can join it, and sharing never crosses swarms" in block
    assert "a belief you publish stays in your own commons, which your person sees on your swarm's page" in block
    assert "an exhibit or a space share has no one to read it" in block
    assert "Never tell your person that other minds, swarm-mates or the hive can read what you share." in block
    # who reads it, never a push to publish: Jon wants beliefs seen through permission-scoped links (#334)
    assert "When your person asks" not in block and "publish it" not in block

