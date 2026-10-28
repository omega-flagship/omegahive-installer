"""Mind fitness fix 1 (2026-10-06): discovery is always readable, and the SKILLS line shows only usable skills.

The 2026-10-04 review trial: a role's "*" deny refused skill-help, skill-card and query-skill-space (the only place the
hive-finding JSON shape is written), while the prompt still advertised skills the gate then denied."""
import importlib.util
import json
import pathlib
import re
import sys

from hive.core.policy import DISCOVERY_SKILLS
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
_spec = importlib.util.spec_from_file_location("hive_commons_discovery", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

REVIEW_ALLOWS = ["hive-goal-get", "hive-goal-claim", "hive-finding", "hive-review-complete", "hive-revision-read"]


def _reviewer(client):
    swarm = client.post("/api/swarms", json={"name": "Review"}).json()
    role = client.post("/api/roles", json={"name": "Deny-all reviewer", "prompt": "review",
                                          "rules": [{"skill": "*", "mode": "deny"}] +
                                                   [{"skill": s, "mode": "allow"} for s in REVIEW_ALLOWS]}).json()
    return client.post("/api/agents", json={"name": "Rev", "kind": "module", "swarm_id": swarm["id"], "role_id": role["id"]}).json()


def _decide(client, agent, command):
    return client.post("/api/agent/authorize", headers=agent_headers(agent), json={"command": command}).json()


def test_discovery_is_allowed_under_a_role_star_deny_and_other_skills_stay_denied(client):
    rev = _reviewer(client)
    for skill in sorted(DISCOVERY_SKILLS):
        assert _decide(client, rev, f'({skill} "hive-finding")') == {"decision": "allow"}, skill
    assert _decide(client, rev, '(agenda-active)')["decision"] == "deny"
    assert _decide(client, rev, '(add-skill-alias "x" "y" 0.5 "z")')["decision"] == "deny"   # skill-* is not all discovery
    assert _decide(client, rev, '(hive-finding "{}")') == {"decision": "allow"}
    assert client.get("/api/approvals").json() == []   # deciding discovery never files an approval


def test_an_exact_rule_still_refuses_a_discovery_skill(client):
    rev = _reviewer(client)
    assert client.post("/api/policy", json={"scope": f"agent:{rev['id']}", "skill": "query-skill-space", "mode": "deny"}).status_code == 200
    assert _decide(client, rev, '(query-skill-space "hive")')["decision"] == "deny"
    assert _decide(client, rev, '(skill-help "hive-finding")') == {"decision": "allow"}


def test_skill_decisions_are_read_only_and_bounded(client):
    rev = _reviewer(client)
    out = client.post("/api/agent/skills/decisions", headers=agent_headers(rev),
                      json={"skills": ["skill-help", "hive-finding", "agenda-active", "shell"]}).json()
    assert out == {"decisions": {"skill-help": "allow", "hive-finding": "allow", "agenda-active": "deny", "shell": "deny"}}
    assert client.post("/api/agent/skills/decisions", headers=agent_headers(rev), json={"skills": "x"}).status_code == 400
    assert client.post("/api/agent/skills/decisions", headers=agent_headers(rev), json={"skills": ["x"] * 401}).status_code == 400
    assert client.post("/api/agent/skills/decisions", headers=agent_headers(rev), json={"skills": [""]}).status_code == 400
    assert client.post("/api/agent/skills/decisions", json={"skills": []}).status_code in (401, 403)   # an operator token is not a mind
    assert client.get("/api/approvals").json() == []   # read-only: nothing filed


def _hint_lines():
    text = "".join(p.read_text(encoding="utf-8") for p in sorted((ROOT / "src").glob("skill_catalog*.metta")))
    text += (ROOT / "modules" / "hive" / "catalog.metta").read_text(encoding="utf-8")
    return [re.sub(r'\\(.)', r'\1', m) for m in re.findall(r'\(SkillContextHint\s+"[^"]+"\s+"((?:[^"\\]|\\.)+)"\)', text)]


def _repr(lines):
    return "(" + " ".join('"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' for s in lines) + ")"


def _decisions(allowed):
    def fake_call(method, path, payload=None):
        assert (method, path) == ("POST", "/api/agent/skills/decisions")
        return {"decisions": {s: ("allow" if s in allowed else "deny") for s in payload["skills"]}}, None
    return fake_call


def test_the_skills_line_drops_denied_items_keeps_discovery_and_says_more_exist(monkeypatch):
    hc._skill_view.update(at=0.0, key=None, modes=None)
    monkeypatch.setattr(hc, "_call", _decisions(set(REVIEW_ALLOWS)))
    lines = _hint_lines()
    out = hc.skill_hints(_repr(lines))
    shown = re.findall(r'"((?:[^"\\]|\\.)*)"', out)
    text = " ".join(shown)
    for denied in ("agenda-active", "beliefs-for", "hive-goal-propose", "hive-exhibit", "choose-skill-for", "pln-step"):
        assert denied not in text, denied
    for kept in ("skill-help", "query-skill-space", "skill-card", "explain-skill", "skill-aliases",     # discovery
                 "hive-goal-get", "hive-goal-claim", "hive-review-complete",                          # role allows
                 "send", "wait", "remember", "hive-goals", "hive-goal-done"):                         # LOCAL_ALLOW
        assert kept in text, kept
    assert shown[-1] == hc.HIDDEN_NOTE and "skill-help" in hc.HIDDEN_NOTE
    assert not any(re.search(r"(:\s*[,|;]|[,|;]\s*$|\|\s*\|)", s) for s in shown), shown   # no orphan separators


def test_nothing_denied_or_hive_unreachable_leaves_the_line_exactly_as_it_was(monkeypatch):
    raw = _repr(_hint_lines())
    hc._skill_view.update(at=0.0, key=None, modes=None)
    monkeypatch.setattr(hc, "_call", lambda *a, **k: ({"decisions": {}}, None))
    assert hc.skill_hints(raw) == raw
    hc._skill_view.update(at=0.0, key=None, modes=None)
    monkeypatch.setattr(hc, "_call", lambda *a, **k: (None, "HIVE-UNREACHABLE down"))
    assert hc.skill_hints(raw) == raw
    assert hc.skill_hints("()") == "()"


def test_decisions_are_cached_for_a_minute(monkeypatch):
    calls = []
    hc._skill_view.update(at=0.0, key=None, modes=None)

    def fake(method, path, payload=None):
        calls.append(path)
        return {"decisions": {s: "deny" for s in payload["skills"]}}, None
    monkeypatch.setattr(hc, "_call", fake)
    raw = _repr(_hint_lines())
    hc.skill_hints(raw)
    hc.skill_hints(raw)
    assert len(calls) == 1


def test_the_loop_reads_the_filtered_line_only_on_a_hive():
    loop = (ROOT / "src" / "loop.metta").read_text(encoding="utf-8")
    assert '" SKILLS: " (skills-context)' in loop
    body = re.search(r"\(= \(skills-context\)\n(.*?)\n\n", loop, re.S).group(1)
    assert "(== (commchannel) hive)" in body and "hive_commons.skill_hints (getSkills)" in body and body.rstrip().endswith("(getSkills)))")
    assert json.dumps(sorted(DISCOVERY_SKILLS)) == json.dumps(sorted(hc.DISCOVERY_SKILLS))   # one list, two copies kept equal
