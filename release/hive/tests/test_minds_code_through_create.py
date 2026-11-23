"""Purpose: test the wall between building and thinking that Jon drew on omega-flagship/omegahive#395 ("Building
software goes to Create, with no exceptions: anything that persists and runs later, such as apps, codebases, HTML apps
and saved programs. Thinking in code isn't software, so it stays a sandboxed tool that asks per use"), enforced at what
would run the code and not by a file's name, and his addition that "a mind's own coding should be a per-mind setting,
off by default, that its owner can switch on". With the default, every skill that builds software is refused whatever
the mind's rules say and an HTML document it writes into an artifact is refused, each naming hive-create, while
thinking in code stays with every mind whatever its own coding (Jon's answer on the switch), its shell asking a person
each use, and a file of any name writes as before; Create's own Code swarm keeps what its role allows; only the mind's
owner switches its own coding, and then it builds as before; an Iter worker's code tools follow the switch."""
import base64
import importlib.util
import json
import pathlib
import re

import pytest

from hive.core import policy
from hive.core.config import load_settings
from hive.core.db import now
from hive.core.foundation import CODE
from hive.core.hive import HiveError
from hive.supervisor import workspace as ws
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (client: fixture)
from hive.tests.test_owner_only_approvals_p3b import env  # noqa: F401  (env: fixture, a mind with a person owner)
from hive.tests.test_phase2_api import authorize

ROOT = pathlib.Path(__file__).resolve().parents[2]
# Every code- head the modules document, in modules/code and in code_workspace, where the skills that need the
# OmegaCode client moved (39183c18), so a head moved between modules is still checked.
CODE_HEADS = sorted({head for catalog in sorted((ROOT / "modules").glob("*/catalog.metta"))
                     for head in re.findall(r'\(SkillHelp "(code-[a-z0-9-]+)"', catalog.read_text())})
# The refused skills, each glob standing for the Code heads it matches, so every pattern is checked on real names.
OWN_CODE = sorted({name for p in policy.OWN_CODE_SKILLS
                   for name in ([h for h in CODE_HEADS if policy._matches(p, h)] if "*" in p else [p])})
# The Code heads a mind outside Create · Code keeps, since none builds or runs code: reads of what Create hands one of
# its own minds (a request's proposal scope and instruction, a review packet) and the Code controller's reads of the
# coding minds it runs. Each answers nothing for a mind that holds none.
KEPT_CODE_HEADS = {"code-proposal-read", "code-proposal-context", "code-helper-instruction", "code-review-packet",
                   "code-mind-templates", "code-mind-status", "code-mind-scan", "code-mind-request", "code-mind-work"}
# Thinking in code, which Jon kept for every mind (#395, 18 Nov: "Thinking in code is allowed by default (calculations,
# analysis, the mind's own MeTTa), as a sandboxed tool", "as long as thinking in code stays available to every mind
# without it", the toggle). The wall leaves each to its own rules: the shell family asks a person each use, as his
# 16:38 line has it, and the MeTTa heads are left to the MeTTa gate.
THINKING = ("shell", "shell-confirm", "vm-shell", "run-metta-file", "metta")
ASKS_EACH_USE = ("shell", "shell-confirm", "vm-shell")


def b64(text):
    return base64.b64encode(text.encode()).decode()


# Writes of every kind and name, programs among them: none is refused for its name or its text, since nothing in the
# hive runs a file a mind wrote but a thinking use, which asks (a .txt name used to get around a check by name).
WRITES = [
    '(write-file "game.html" "<p>tic</p>")', '(write-file "src/app.py" "print(1)")', '(append-file "tool.sh" "echo")',
    '(write-file "Makefile" "all:")', '(write-file "run.txt" "#!/bin/sh echo hi")',
    f'(write-file-base64 "board.js" "{b64("let board = []")}")',
    f'(write-file-base64 "run" "{b64("#!/usr/bin/env python3")}")',
    '(write-file "plans/weekend.md" "# Weekend plan")', '(write-file "notes.txt" "milk, eggs")',
    '(write-file "data.csv" "a,b")', f'(append-file-base64 "log.txt" "{b64("done")}")']


def mind(client, **fields):
    _, (a, _) = make_swarm_and_agents(client, **fields)
    return a, client.app.state.hive.agent(a["id"])


def switch(e, on, actor="owner"):
    """The mind's own coding, switched by actor through the mind's settings route."""
    return e["c"].patch("/api/agents/" + e["mind"]["id"], headers=e["headers"][actor],
                        json={"options": {"own_coding": True} if on else {}})


def test_every_skill_that_builds_software_is_refused_to_a_mind_whatever_its_rules_say(client):
    hive = client.app.state.hive
    a, row = mind(client)
    for skill in OWN_CODE:   # a person's Always for this mind and an admin's allow for the whole hive
        hive.policy.add_rule(f"agent:{a['id']}", skill, "allow", origin=policy.ORIGIN_ANSWER)
        hive.policy.add_rule("hive", skill, "allow")
    for skill in OWN_CODE:
        assert hive.policy.decide(row, skill) == ("deny", policy.OWN_CODE_REASON), skill
        decision = authorize(client, a, f'({skill} "x")')
        assert decision["decision"] == "deny" and "hive-create" in decision["message"], (skill, decision)
    # and the way the refusal names stays open to that very mind
    assert hive.policy.decide(row, "hive-create")[0] == "allow"
    assert authorize(client, a, '(hive-create "a tic tac toe game")')["decision"] == "allow"


@pytest.mark.parametrize("skill", THINKING)
def test_thinking_in_code_stays_with_every_mind_whatever_its_own_coding(env, skill):
    """With its own coding off a mind decides each thinking tool, and a command of it, exactly as with it on, so the
    wall refuses none; the shell family asks a person each use."""
    hive, made = env["h"], env["mind"]
    assert not any(policy._matches(p, skill) for p in policy.OWN_CODE_SKILLS)
    decided = []
    for on in (False, True):
        assert switch(env, on).status_code == 200
        decided.append((hive.policy.decide(hive.agent(made["id"]), skill),
                        authorize(env["c"], made, f'({skill} "1 + 2")')["decision"]))
    assert decided[0] == decided[1] and decided[0][0][0] != "deny", decided
    if skill in ASKS_EACH_USE:
        assert (decided[0][0][0], decided[0][1]) == ("ask", "pending")


def test_every_code_module_head_is_refused_to_a_mind_but_the_reads_create_hands_its_own_minds(client):
    """A head added to the Code module is refused to a mind outside Create · Code (foundation.WORKSPACE_HEADS) unless it
    only reads what Create hands one of its own minds; then it goes in KEPT_CODE_HEADS, with that reason."""
    hive = client.app.state.hive
    _, row = mind(client)
    assert len(CODE_HEADS) >= 40
    assert {h for h in CODE_HEADS if hive.policy.decide(row, h)[0] != "deny"} == KEPT_CODE_HEADS


@pytest.mark.parametrize("command", WRITES)
def test_no_refusal_depends_on_a_file_s_name_or_text(client, command):
    """Every write keeps the rule it had: write-file and append-file ask a person by default."""
    a, _ = mind(client)
    assert authorize(client, a, command)["decision"] == "pending"


def revise(client, a, kind, body):
    art = client.post("/api/agent/artifacts", headers=agent_headers(a), json={"kind": kind, "title": f"A {kind}"})
    assert art.status_code == 200, art.text
    return client.post(f"/api/agent/artifacts/{art.json()['id']}/revisions", headers=agent_headers(a),
                       json={"body": body, "parent": None})


HTML_BODIES = [
    ("app", "<!DOCTYPE html><html><body><script>let board = []</script></body></html>"),
    ("note", "\ufeff\n  <html lang='en'><body>tic</body></html>"),
    ("view", "<div id='board'></div><script>play()</script>"),
    ("view", '{"mimeType": "text/html;profile=mcp-app", "text": "<html><body>tic</body></html>"}'),
]


@pytest.mark.parametrize("kind,body", HTML_BODIES)
def test_a_mind_writing_an_html_document_into_an_artifact_is_refused(client, kind, body):
    a, _ = mind(client)
    response = revise(client, a, kind, body)
    assert response.status_code == 403 and "hive-create" in response.text, response.text


@pytest.mark.parametrize("kind,body", [
    ("plan", "# Weekend plan\n- Saturday: the coast walk\n- Sunday: market, then lunch"),
    ("view", '(Screen tip "Tip calculator")\n(Part tip (Field bill "Bill"))'),
    ("note", "<b>Remember</b> the tickets"),      # a fragment in a document is text, not a page
])
def test_a_saved_plan_a_note_and_a_metta_view_still_go_through(client, kind, body):
    a, _ = mind(client)
    assert revise(client, a, kind, body).status_code == 200


def test_an_app_acting_for_a_mind_still_publishes_its_html_view(client):
    """An app's view is the app's: programs.publish writes as the principal the app acts under (programs._acting),
    here the mind, and the same document the mind's own route refuses goes through."""
    hive = client.app.state.hive
    a, row = mind(client)
    page = "<!DOCTYPE html><html><body>an app's own view</body></html>"
    art = hive.collab.create_artifact(row, {"kind": "view", "title": "An app's view"}, principal=f"agent:{a['id']}")
    rev = hive.collab.add_revision(row, art["id"], {"body": page, "parent": None}, principal=f"agent:{a['id']}")
    assert rev["n"] == 1
    assert revise(client, a, "view", page).status_code == 403


def bind_create_code(hive, agent_id, swarm_id):
    """Make agent_id Create · Code's mind and swarm_id its swarm, as the foundation binds them (person_minds)."""
    if hive.db.one("SELECT 1 FROM person_minds WHERE purpose = ?", (CODE,)) is None:
        hive.db.insert("person_minds", {"principal": "host:foundation", "purpose": CODE, "agent_id": agent_id,
                                        "swarm_id": swarm_id, "created_at": now(), "updated_at": now()})
    else:
        hive.db.execute("UPDATE person_minds SET agent_id = ?, swarm_id = ? WHERE purpose = ?",
                        (agent_id, swarm_id, CODE))


def test_create_code_swarm_minds_keep_what_their_role_allows(client):
    """Create · Code's own minds are Create: the wall leaves them to their rules, while a mind elsewhere is refused.
    A helper's role (foundation.HELPER_DENIED) still keeps it to the proposal path."""
    hive = client.app.state.hive
    swarm, (coder, helper) = make_swarm_and_agents(client)
    bind_create_code(hive, coder["id"], swarm["id"])
    other, _ = mind(client)
    for a in (coder, helper):
        assert hive.policy.create_code_mind(hive.agent(a["id"]))
        assert hive.policy.decide(hive.agent(a["id"]), "codex-code") != ("deny", policy.OWN_CODE_REASON)
    assert hive.policy.decide(hive.agent(other["id"]), "codex-code") == ("deny", policy.OWN_CODE_REASON)


def test_a_mind_is_shown_none_of_the_refused_skills_and_still_sees_its_thinking_tools(client):
    """policy.decisions feeds the SKILLS line a mind sees (hive_commons), which names only what it may use or ask
    for."""
    hive = client.app.state.hive
    _, row = mind(client)
    seen = hive.policy.decisions(row, [*OWN_CODE, *THINKING, "write-file", "read-file", "hive-artifact-create",
                                       "hive-create"])["decisions"]
    assert {s for s, mode in seen.items() if mode == "deny"} == set(OWN_CODE)
    assert seen["read-file"] == "allow" and seen["hive-artifact-create"] == "allow" and seen["hive-create"] == "allow"
    assert {s: seen[s] for s in (*THINKING, "write-file")} == dict.fromkeys((*THINKING, "write-file"), "ask")


def test_a_mind_whose_owner_switched_its_own_coding_on_builds_as_before(env):
    """Switched on, the wall leaves that one mind to its rules: each refused skill gets back the default it had
    before (fixtures/policy_defaults_6606.json own_code.was), an HTML artifact saves, and the owner can switch it off
    again. Its neighbour, the owner's other mind, stays behind the wall."""
    hive, mind_id = env["h"], env["mind"]["id"]
    pinned = json.loads((pathlib.Path(__file__).parent / "fixtures/policy_defaults_6606.json").read_text())
    was = pinned["own_code"]["was"]
    assert switch(env, True).status_code == 200
    coding = hive.agent(mind_id)
    assert coding["options"]["own_coding"] is True
    assert {s: hive.policy.decide(coding, s)[0] for s in was} == was
    assert hive.policy.own_code_revision(coding, "app", HTML_BODIES[0][1], None) is None
    neighbour = env["c"].post("/api/agents", headers=env["headers"]["owner"],
                              json={"name": "Its neighbour", "kind": "module"})
    assert hive.policy.decide(hive.agent(neighbour.json()["id"]), "code-open") == ("deny", policy.OWN_CODE_REASON)
    assert switch(env, False).status_code == 200
    assert "own_coding" not in hive.agent(mind_id)["options"]
    assert hive.policy.decide(hive.agent(mind_id), "code-open") == ("deny", policy.OWN_CODE_REASON)


@pytest.mark.parametrize("actor", ("member", "admin", "hiveowner"))
@pytest.mark.parametrize("clear", (False, True))
def test_only_its_owner_switches_a_mind_s_own_coding(env, actor, clear):
    """An admin, the hive's owner and a member who sees the mind are all refused, whether they set it or clear it by
    sending the mind's options without it."""
    if clear:
        assert switch(env, True).status_code == 200
    before = env["h"].agent(env["mind"]["id"])["options"]
    r = switch(env, not clear, actor)
    assert r.status_code == 403 and r.json()["error"]["code"] in ("own_coding_owner_only", "owner_only"), r.text
    assert env["h"].agent(env["mind"]["id"])["options"] == before


@pytest.mark.parametrize("operation", ("create", "update"))
def test_the_central_writer_does_not_trust_a_privileged_nonowner_with_it(env, operation):
    h = env["h"]
    with pytest.raises(HiveError) as caught:
        if operation == "create":
            h.create_agent("Wrong writer", kind="module", owner="user:u_p3b_owner", by="user:u_p3b_admin",
                           options={"own_coding": True})
        else:
            h.update_agent(env["mind"]["id"], {"options": {"own_coding": True}}, by="user:u_p3b_admin", privileged=True)
    assert caught.value.code == "own_coding_owner_only"
    assert "own_coding" not in h.agent(env["mind"]["id"])["options"]


@pytest.mark.parametrize("value", (None, "yes", 1, ["on"]))
def test_a_malformed_switch_is_refused_rather_than_dropped(env, value):
    r = env["c"].patch("/api/agents/" + env["mind"]["id"], headers=env["headers"]["owner"],
                       json={"options": {"own_coding": value}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_options", r.text


def test_only_its_owner_is_shown_the_switch(env):
    """may_switch_own_coding, the host's hint the settings read (features/dot/ownCoding.ts), is the write's own rule."""
    def flag(actor):
        listed = env["c"].get("/api/agents", headers=env["headers"][actor]).json()
        rows = listed if isinstance(listed, list) else listed.get("agents", [])
        return next(m for m in rows if m["id"] == env["mind"]["id"])["may_switch_own_coding"]
    assert flag("owner") is True and flag("admin") is False


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_an_iter_minds_shell_asks_the_gate_each_use_and_runs_only_what_it_allows(monkeypatch):
    shell = load("hive/templates/iter/tools/shell.py", "iter_kit_shell")
    asked = []

    def gate(decision):
        def call(method, path, payload=None, timeout=None):
            asked.append((method, path, payload))
            return {"decision": decision, "message": "HIVE-ASK a person approves (shell \"echo hi\")"}, None
        return call

    monkeypatch.setattr(shell._hive, "call", gate("pending"))
    assert shell.run("echo hi") == 'HIVE-ASK a person approves (shell "echo hi")'
    assert asked == [("POST", "/api/agent/authorize", {"command": '(shell "echo hi")'})]
    monkeypatch.setattr(shell._hive, "call", gate("allow"))
    assert shell.run("echo hi") == "SUCCESS, RETURN: hi\n"
    monkeypatch.setattr(shell, "SECONDS", 0.2)
    assert shell.run("sleep 5; echo late") == "timeout_error"


def loaded(root):
    """The tools an Iter loop loads from a worker: tools/*.py but those starting with an underscore (iter.py
    load_tools, utils.metta python-files)."""
    return {p.name for p in (root / "tools").glob("*.py") if not p.name.startswith("_")}


def max_tools(root):
    """The MAX_TOOLS the worker's Iter loop was given (workspace.sync_iter): Iter loads only that many tools."""
    return int(re.search(r"^MAX_TOOLS = (\d+)$", (root / "iter.py").read_text(), re.M)[1])


def test_an_iter_workers_code_tools_follow_its_mind_s_own_coding(tmp_path):
    """With the wall up a worker has the kit's shell, which asks the gate, the kit's metta, which runs in the sandbox for
    thinking in code (test_iter_think_sandbox), and no python; switched on it has Iter's own shell, python and metta, a
    self-modifying Iter; each switch reaches the worker at its next start (workspace.ITER_CODE_TOOLS)."""
    w = ws.Workspace(load_settings(data_dir=tmp_path / "hive", admin_password="pw"))   # the pinned third_party/iter
    agent = {"id": "a_itercode", "name": "Ivy", "kind": "iter"}
    root = w.create(agent, "tok")
    kit = {name: (ROOT / "hive/templates/iter/tools" / name).read_text() for name in ("shell.py", "metta.py")}
    upstream = w.iter_source() / "tools"
    tools = loaded(root)
    assert {"send.py", "hive_create.py", "shell.py", "metta.py"} <= tools and "python.py" not in tools, sorted(tools)
    assert {name: (root / "tools" / name).read_text() for name in kit} == kit
    assert (root / "tools/_think_sandbox.py").exists()
    assert len(tools) <= max_tools(root)              # Iter loads only the first MAX_TOOLS: none may be cut
    w.sync_iter({**agent, "options": {"own_coding": True}})
    for name in ws.ITER_CODE_TOOLS:
        assert (root / "tools" / name).read_text() == (upstream / name).read_text(), name
    assert len(loaded(root)) <= max_tools(root)
    w.sync_iter(agent)
    assert {name: (root / "tools" / name).read_text() for name in kit} == kit
    assert not (root / "tools/python.py").exists()


def test_a_metta_loop_worker_switched_on_gets_its_own_metta_back(tmp_path):
    """The MeTTa-loop variant keeps its own tools/metta.py (workspace.ITER_METTA_OVERRIDES), which also imports the
    worker's metta/ files: switched on, that one comes back, and the kit's sandboxed metta replaces it otherwise."""
    w = ws.Workspace(load_settings(data_dir=tmp_path / "hive", admin_password="pw"))
    own = w.iter_source("iter_metta") / "tools/metta.py"
    if not own.exists():
        pytest.skip("third_party/iter-metta is not checked out")
    agent = {"id": "a_itermetta", "name": "Ivy", "kind": "iter", "options": {"iter_variant": "metta"}}
    root = w.create(agent, "tok")
    kit = (ROOT / "hive/templates/iter/tools/metta.py").read_text()
    assert (root / "tools/metta.py").read_text() == kit
    w.sync_iter({**agent, "options": {"iter_variant": "metta", "own_coding": True}})
    assert (root / "tools/metta.py").read_text() == own.read_text()
    w.sync_iter(agent)
    assert (root / "tools/metta.py").read_text() == kit
