# Purpose: tests that a mind can draft a flow from the hive's own card and refusal, the card's example being a flow the
# hive accepts and could run once a person adopts it, that a mind in no swarm is told a flow needs one and what the
# person can do, and that the code-mind cards send a person who asks another mind for a code mind to Create.
"""A mind learns to draft a flow, and where code minds come from (testers' v0.28 gate, 13 Nov).

Asked to make and publish a flow, a tester's mind sent hive-flow-draft a body written as text four times, got
"HIVE-ERROR invalid_flow: invalid flow header" each time and gave up: the skill's help said only "{title,body,layout}",
and the refusal never said what a body is. Asked for a code mind, another read the code-mind skills, which need a
request's team and request ids it could not have, and stopped.
"""
import json
import pathlib
import re

from hive.flow_ir.admission import prepare
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_flows import setup  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]


def card(module, skill):
    """The SkillCardLine texts a mind's skill-card shows for this skill, unescaped as MeTTa reads them."""
    text = (ROOT / "modules" / module / "affordance.metta").read_text(encoding="utf-8")
    found = re.findall(r'^\(SkillCardLine "' + re.escape(skill) + r'" "((?:[^"\\]|\\.)*)"\)$', text, re.M)
    return [re.sub(r"\\(.)", r"\1", line) for line in found]


def test_the_draft_card_example_is_a_flow_the_hive_accepts_and_could_run_once_adopted(setup):
    c, _owner, swarm, worker, *_ = setup
    [example] = [line for line in card("hive", "hive-flow-draft") if "one-step example" in line]
    data = json.loads(example[example.index("{"):].replace("YOUR_SWARM_ID", swarm["id"]))
    out = c.post("/api/agent/flows", headers=agent_headers(worker), json=data)
    assert out.status_code == 200, out.text
    assert out.json()["swarm_id"] == swarm["id"] and out.json()["execution_authorized"] is False
    adopted = json.loads(json.dumps(data["body"]))
    for element in adopted["elements"]:
        element["meta"]["revision_state"] = "adopted"     # what a person's adoption in Flows records
    assert prepare(adopted)["structurally_eligible"] is True


def test_a_body_written_as_text_is_told_the_shape_its_swarm_and_the_card(setup):
    c, _owner, swarm, worker, *_ = setup
    guess = {"title": "gate-hello", "body": "Flow gate-hello: one step that says hello to the user.",
             "layout": {"steps": [{"id": "s1", "kind": "send", "text": "Hello from gate-hello!"}]}}
    out = c.post("/api/agent/flows", headers=agent_headers(worker), json=guess)
    assert out.status_code == 400
    error = out.json()["error"]
    assert error["code"] == "invalid_flow" and error["message"].startswith("invalid flow header: ")
    assert "omegaflow/1" in error["message"] and swarm["id"] in error["message"]
    assert "skill-card hive-flow-draft" in error["message"]


def test_the_draft_card_says_who_adopts_and_that_publishing_asks_for_permission():
    [shape, _example, after, alone] = card("hive", "hive-flow-draft")
    assert "omegaflow/1" in shape and "never text" in shape
    assert "a person adopts it in Flows" in after and "hive-flow-publish" in after and "permission" in after
    assert "A flow belongs to your swarm" in alone and "move you into a swarm" in alone


def test_a_mind_on_its_own_is_told_a_flow_needs_a_swarm_not_that_fields_are_missing(setup):
    """v0.29: Create makes a new mind On its own unless the person picks a group. Asked for a flow, one such mind sent
    a whole omegaflow/1 draft and was told "kind and title are required, from a mind in a swarm"."""
    c, owner, swarm, _worker, *_ = setup
    loner = c.post("/api/agents", headers=owner, json={"name": "Lone gardener"}).json()
    assert loner.get("swarm_id") is None
    [example] = [line for line in card("hive", "hive-flow-draft") if "one-step example" in line]
    draft = json.loads(example[example.index("{"):].replace("YOUR_SWARM_ID", swarm["id"]))
    out = c.post("/api/agent/flows", headers=agent_headers(loner), json=draft)
    assert out.status_code == 400
    error = out.json()["error"]
    assert error["code"] == "no_swarm" and "kind and title" not in error["message"]
    assert "a flow belongs to a swarm and you are in none" in error["message"]
    assert "the Swarm choice on your panel" in error["message"]


def test_the_code_mind_cards_send_a_person_who_asks_another_mind_to_create():
    for skill in ("code-mind-templates", "code-mind-spawn"):
        assert any("tell them to ask Create" in line for line in card("code", skill)), skill
