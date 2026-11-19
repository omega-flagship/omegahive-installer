"""Purpose: the heads #82 kept from 6606 that Jon's rule on omega-flagship/omegahive#230 says ask each time (they run
code, capture a device, restart or change the hive or the mind, send outward, write to the web or outside the sandbox,
or spend money), and the other names for a head that asks, ask a person by default; omega-flagship/omegahive#232 tracks
them. A person can still let one mind run such a head, one approval lets one paid image through both of its gates, and
an act approved one at a time stays so under every name it has. The MeTTa memory heads are decided by what their command
reaches instead (Jon's call on omega-flagship/omegahive#76, test_metta_reach)."""
import fnmatch
import json
import pathlib
import re

import pytest

from hive.core import policy
from hive.core.hive import HiveError
from hive.core.services import CODE_MUTATING
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_five_way_decisions import decide
from hive.tests.test_phase2_api import authorize

ROOT = pathlib.Path(__file__).resolve().parents[2]
RISK = re.compile(r'\(Risk "([^"]+)" "([^"]+)"\)')

# Declared risks whose effect reaches past the hive and the mind's own memory: messages, calls to remote agents, the
# public web, a device in the home, processes, commands and code, files, repositories and other minds.
OUTSIDE = frozenset({
    "external-send", "external-network-call", "public-web-write", "public-web-publish", "physical-world-action",
    "runtime-restart", "vm-reboot", "vm-command", "vm-command-risky", "nested-vm-command", "starts-local-process",
    "direct-symbolic-execution", "workspace-execution", "workspace-write", "file-write", "repo-write", "mind-lifecycle",
})

# Heads in such a class that still run by default, because each does less than its class says.
RUNS_UNASKED_ANYWAY = {
    "send-control": "is (send $msg)",
    "send-primary-operator": "posts only to the operator's WhatsApp primary chat, which send already reaches",
    "send-telegram": "posts only to the operator's Telegram chat, which send already reaches",
    "send-web-control": "posts only to the operator's web chat, which send already reaches",
    "send-hive-to": "answers a conversation in the hive",
    "code-create": "an edit, which OmegaCode asks a person for (code-edit)",
    "code-move": "an edit, which OmegaCode asks a person for (code-edit)",
    "code-remove": "an edit, which OmegaCode asks a person for (code-edit)",
    "code-replace": "an edit, which OmegaCode asks a person for (code-edit)",
}

# The heads #82 kept from 6606 that ask each time under Jon's rule (omega-flagship/omegahive#230,
# issuecomment-6827848975), which omega-flagship/omegahive#232 tracks. reboot-self left it: outside the mind's own VM it
# is refused (omega-flagship/omegahive#299, test_policy_review_299). space-merge-atoms, persistent-merge-atoms and
# retire-persistent-expression left it for the reach rule: on the mind's own atoms they run without asking (#76).
ASK_EACH_TIME = (
    "agentverse-ask", "agentverse-call", "agentverse-listener-start", "agentverse-listener-stop", "capture-webcam",
    "code-exec", "code-proof-check", "code-test-run", "delete-whatsapp-message", "edit-whatsapp-message",
    "edit-whatsapp-message-base64", "generate-image", "generate-image-quality", "generate-video", "initChannels",
    "inspect-image", "inspect-webcam", "mark-whatsapp-read", "mark-whatsapp-unread", "observe", "observe-image",
    "publish-artifact", "react-whatsapp-message",
    "reply-whatsapp-file-caption-to", "reply-whatsapp-file-to", "reply-whatsapp-to", "reply-whatsapp-to-base64",
    "reply-whatsapp-to-message", "reply-whatsapp-to-message-base64", "restart-self",
    "run-metta-file", "send-family", "send-family-file", "send-whatsapp", "send-whatsapp-base64", "send-whatsapp-file",
    "send-whatsapp-file-caption", "send-whatsapp-file-caption-to", "send-whatsapp-file-to", "send-whatsapp-mention",
    "send-whatsapp-mention-to", "send-whatsapp-to", "send-whatsapp-to-base64", "set-whatsapp-primary",
    "unpublish-artifact", "unreact-whatsapp-message", "use-house-affordance", "vm-boot",
    "vm-shell", "write-web-page",
)


def declared_risks():
    """{risk: {skill, ...}} from the Risk atoms of every module and of the runtime's own skills."""
    risks = {}
    for path in [*ROOT.glob("modules/*/affordance.metta"), *ROOT.glob("hive/runtime/extensions/*.metta")]:
        for skill, risk in RISK.findall(path.read_text()):
            risks.setdefault(risk, set()).add(skill)
    return risks


def a_mind(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    return hive, hive.agent(a["id"])


def asks_by_name(skill):
    return skill in policy.HIGH_RISK or any(policy._matches(p, skill) for p in policy.DEFAULT_ASK)


def test_the_risk_scan_still_sees_known_declarations():
    """If the scan's pattern goes deaf, fail loudly instead of passing everything."""
    risks = declared_risks()
    for skill, risk in (("use-house-affordance", "physical-world-action"), ("restart-omega", "runtime-restart"),
                        ("send-whatsapp", "external-send"), ("space-transform", "symbolic-memory-mutation")):
        assert skill in risks.get(risk, ()), (skill, risk)
    assert sum(map(len, risks.values())) >= 120


def test_no_head_runs_unasked_when_its_declared_risk_reaches_outside_or_a_head_sharing_it_asks(client):
    """A head runs without a person only if its module's declared risk stays inside the hive and no head declaring the
    same risk asks by name, so a new name for an asking act asks too."""
    hive, mind = a_mind(client)
    unasked = sorted(skill for risk, members in declared_risks().items() for skill in members
                     if hive.policy.decide(mind, skill)[0] == "allow" and skill not in RUNS_UNASKED_ANYWAY
                     and (risk in OUTSIDE or any(asks_by_name(other) for other in members - {skill})))
    assert not unasked, f"these run without a person although their declared risk says a person decides: {unasked}"


@pytest.mark.parametrize("name,head", [
    ("restart-self", "restart-omega"), ("run-metta-file", "metta"),
    ("space-merge-atoms", "space-transform"), ("persistent-merge-atoms", "space-transform"),
    ("retire-persistent-expression", "persistent-cleanup-commit"), ("vm-shell", "shell"),
    ("send-whatsapp-file", "send-file"), ("send-family-file", "send-file"), ("reply-whatsapp-file-to", "send-file"),
])
def test_another_name_for_a_head_that_asks_is_answered_the_same_way(client, name, head):
    hive, mind = a_mind(client)
    assert hive.policy.decide(mind, name) == hive.policy.decide(mind, head)
    assert (name in policy.HIGH_RISK) == (head in policy.HIGH_RISK)


def test_a_person_can_let_one_mind_send_to_a_whatsapp_chat_while_the_others_still_ask(client):
    _, (a, b) = make_swarm_and_agents(client)
    command = '(send-whatsapp-to "invented-chat@g.us" "Invented message")'
    pending = authorize(client, a, command)
    assert pending["decision"] == "pending"
    assert decide(client, pending["approval_id"], "always").json()["status"] == "approved"
    authorize(client, a, command)                                                          # the one-shot grant
    assert authorize(client, a, '(send-whatsapp-to "invented-chat@g.us" "Another")')["decision"] == "allow"
    assert authorize(client, b, command)["decision"] == "pending"                          # only that mind


def test_restart_self_is_approved_one_at_a_time_like_restart_omega(client):
    _, (a, _) = make_swarm_and_agents(client)
    pending = authorize(client, a, '(restart-self "invented reason")')
    assert pending["decision"] == "pending"
    always = decide(client, pending["approval_id"], "always")
    assert always.status_code == 400 and always.json()["error"]["code"] == "one_at_a_time"
    assert decide(client, pending["approval_id"], "once").json()["status"] == "approved"


def test_one_approval_lets_one_paid_image_through_the_minds_gate_and_the_media_route(client):
    """generate-image spends money, so each image asks; the media route redeems the approval the mind's own gate just
    used (Policy.enforce), so a person approves an image once, and the next image asks again."""
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    command = '(generate-image "an invented garden")'
    pending = authorize(client, a, command)
    assert pending["decision"] == "pending"
    assert decide(client, pending["approval_id"], "once").json()["status"] == "approved"
    assert authorize(client, a, command)["decision"] == "allow"                  # the mind's gate runs the skill
    hive.policy.enforce(hive.agent(a["id"]), "generate-image", command)           # the media route redeems it
    with pytest.raises(HiveError) as asked:
        hive.policy.enforce(hive.agent(a["id"]), "generate-image", command)       # the next image asks again
    assert asked.value.code == "approval_required"


def _command(skill):
    """A well-formed command for skill: a file skill gets a path inside the mind's folder where it reads its path."""
    index = policy.FILE_SKILLS.get(skill)
    if index is None:
        return f'({skill} "invented argument")'
    return f'({skill}' + ' "invented-chat@g.us"' * index + ' "invented.txt")'


def test_every_head_jons_rule_names_asks_a_person_at_the_policy_gate(client):
    _, (a, _) = make_swarm_and_agents(client)
    answered = {skill: authorize(client, a, _command(skill))["decision"] for skill in ASK_EACH_TIME}
    assert {skill: decision for skill, decision in answered.items() if decision != "pending"} == {}


def test_the_list_holds_every_send_whatsapp_head():
    """Jon's rule names send-whatsapp*: every 6606 head the glob matches is on the list."""
    pinned = json.loads((pathlib.Path(__file__).parent / "fixtures/policy_defaults_6606.json").read_text())["defaults"]
    heads = {skill for skill in pinned if fnmatch.fnmatchcase(skill, "send-whatsapp*")}
    assert len(heads) == 10 and heads <= set(ASK_EACH_TIME)


def test_code_edit_heads_run_while_the_operations_they_reach_ask_for_their_exact_binding(client):
    """Why the edit, open and check heads stay allowed: each works inside the mind's Code workspace or records a verdict
    on a finished run, and reaches an OmegaCode operation the hive asks a person for, bound to that exact operation
    (test_services_api covers the binding and its one redemption). The heads that run code (code-exec,
    code-proof-check, code-test-run) are on ASK_EACH_TIME."""
    hive, mind = a_mind(client)
    for head, operation in (("code-open", "code-workspace"), ("code-replace", "code-edit"),
                            ("code-create", "code-edit"), ("code-move", "code-edit"), ("code-remove", "code-edit"),
                            ("code-check", "code-verify")):
        assert hive.policy.decide(mind, head)[0] == "allow", head
        assert operation in CODE_MUTATING and hive.policy.decide(mind, operation)[0] == "ask", operation
