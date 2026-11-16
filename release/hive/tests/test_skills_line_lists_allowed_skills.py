# Purpose: tests that a mind's SKILLS line names the web and file skills its policy allows, every skill a host notice
# tells a mind to run, and that neither the line's note nor the mind prompt makes an unlisted skill read as forbidden.
"""A mind is shown the skills its policy lets it use for a person's everyday asks (tester report 11-13).

Create · Code and an imported mind each told a tester they could not open her PDF because hive-asset-get wasn't
available to them, and that they needed a permission for web search. Both skills were allowed. The SKILLS line a mind
sees is its runtime's SkillContextHint lines less what its policy denies, and no hint named either skill, while the mind
prompt said "Use only listed SKILLS" and the line's closing note said an unlisted skill is one "your policy does not
allow". The file notice itself told the minds to "read it with hive-asset-get <sha> -".

Invented lives: Rosa runs a bakery swarm whose mind Juno reads the files she adds and looks things up on the web.
"""
import ast
import importlib.util
import pathlib
import re

from hive.runtime.extensions import helper_command_parser as parser
from hive.supervisor import workspace as ws
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hive_commons_skills_line", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

# What a person most often asks a mind for, all allowed by the hive's defaults (policy.DEFAULT_ALLOW and "hive-*").
EVERYDAY = ("web-search", "web-fetch", "hive-asset-list", "hive-asset-get", "hive-asset-put", "hive-shared", "hive-request")
# A notice the hive sends only to one kind of mind, so its skill is not shown to every mind: the reason, per skill.
ONE_MIND_NOTICES = {"hive-health": "Health alerts go only to the Health mind (health.py); every other mind would be "
                                   "shown a skill the route refuses it"}


def _hint_lines():
    """Every SkillContextHint line a hive mind's runtime loads: the core's catalogs and each enabled module's."""
    lines = []
    for path in parser._skill_catalog_declaration_paths():
        lines += [re.sub(r'\\(.)', r'\1', m) for m in
                  re.findall(r'\(SkillContextHint\s+"[^"]+"\s+"((?:[^"\\]|\\.)+)"\)', path.read_text(encoding="utf-8"))]
    return lines


def _repr(lines):
    return "(" + " ".join('"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' for s in lines) + ")"


def _skills_line(client, monkeypatch, agent):
    """The SKILLS line this mind is shown: hive_commons.skill_hints over the real hints, asking this hive with the
    mind's own token, as the mind's loop does on every turn."""
    def call(method, path, payload=None):
        r = client.request(method, path, json=payload, headers=agent_headers(agent))
        return (r.json(), None) if r.status_code < 400 else (None, f"HIVE-ERROR {r.status_code}")
    hc._skill_view.update(at=0.0, key=None, modes=None)
    monkeypatch.setattr(hc, "_call", call)
    return " ".join(re.findall(r'"((?:[^"\\]|\\.)*)"', hc.skill_hints(_repr(_hint_lines()))))


def _juno(client):
    hive = client.app.state.hive
    bakery = client.post("/api/swarms", json={"name": "Bakery"}).json()
    return hive.create_agent("Juno", "omega", bakery["id"], "mock/echo", "", None, 0, None, None)


def test_a_minds_skills_line_names_the_web_and_file_skills_its_policy_allows(client, monkeypatch):
    juno = _juno(client)
    line = _skills_line(client, monkeypatch, juno)
    for skill in EVERYDAY:
        assert skill in line, skill
    # the line is still filtered: code-mind-spawn needs an exact allow rule (policy.EXPLICIT_ONLY), so it is left out
    assert "code-mind-spawn" not in line and line.endswith(hc.HIDDEN_NOTE)


def test_a_skill_its_policy_denies_is_left_out_and_the_note_never_calls_unlisted_skills_denied(client, monkeypatch):
    juno = _juno(client)
    assert client.post("/api/policy", json={"scope": f"agent:{juno['id']}", "skill": "web-search", "mode": "deny"}).status_code == 200
    line = _skills_line(client, monkeypatch, juno)
    assert "web-search" not in line and "web-fetch" in line and "hive-asset-get" in line
    note = hc.HIDDEN_NOTE
    # the note says what was left out and where unlisted skills are found; "Not listed: skills your policy does not
    # allow" told minds every unlisted skill was denied
    assert "your policy does not allow" in note and "may still be yours" in note
    assert "query-skill-space" in note and "skill-help" in note


def _notice_skills():
    """(skill, file:line) for every skill a hive/core string tells a mind to run ("read it with hive-asset-get ...")."""
    heads = set(parser.SIGNATURE_COMMANDS)
    found = []
    for path in sorted((ROOT / "hive" / "core").glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                for skill in re.findall(r"\b(?:with|run|use)\s+((?:hive|web|code)-[a-z-]+)", node.value):
                    if skill in heads:
                        found.append((skill, f"{path.name}:{node.lineno}"))
    return found


def test_every_skill_a_host_notice_tells_a_mind_to_run_is_on_the_skills_line():
    found = _notice_skills()
    assert {s for s, _ in found} >= {"hive-asset-get", "hive-asset-list", "hive-shared"}   # the scan sees the notices
    heads = set(parser.SIGNATURE_COMMANDS)
    listed = {s for line in _hint_lines() for s in hc._line_skills(line, heads)}
    missing = sorted({(s, where) for s, where in found if s not in listed and s not in ONE_MIND_NOTICES})
    assert missing == [], f"a notice tells minds to run these, but no SkillContextHint names them: {missing}"


def test_the_mind_prompt_never_limits_a_mind_to_the_skills_its_line_lists():
    text = ws.HIVE_BASE_PROMPT.read_text(encoding="utf-8")
    assert not re.search(r"use only (the )?listed skills", text, re.I)
    assert "Discovery finds the rest" in text and "the hive decides, and asks a person itself" in text
