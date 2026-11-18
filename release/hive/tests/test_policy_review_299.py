"""Purpose: the permission-gate items of Jon's second review (omega-flagship/omegahive#299, items 1 and 2) hold: a shell or
any other run of code is approved one at a time, never "Always"; every skill that takes a path on this computer keeps
it inside the mind's own folder; the private-data reads, persistent-expression and body-container-launcher ask a person;
reboot-self exists only where the hive is the mind's own VM; and test-metta, which only checks syntax, stays allowed."""
import pathlib
import re

import pytest

from hive.core import policy
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_five_way_decisions import decide
from hive.tests.test_phase2_api import authorize

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH_ARG = re.compile(r'\(SkillArg "([^"]+)" (\d+) "filepath"')

CODE_RUNS = ("shell", "vm-shell", "code-exec", "code-test-run", "code-proof-check", "codex-code", "codex-code-start",
             "codex-code-readonly", "codex-code-readonly-start")
PRIVATE_READS = ("read-whatsapp-chat", "read-whatsapp-chat-full", "read-whatsapp-chat-recent", "whatsapp-chats",
                 "whatsapp-inbox", "observe-glucose", "glucose-history", "glucose-rings", "glucose-watch-status",
                 "set-glucose-watch", "observe-house",
                 "observe-house-full", "observe-house-affordances", "observe-room", "observe-device",
                 "house-action-log", "webcam-observation-log", "audio-observation-log")


@pytest.mark.parametrize("skill", CODE_RUNS)
def test_a_shell_or_any_other_code_run_is_approved_one_at_a_time(client, skill):
    """Jon's rule: shell asks every time, so one "Always" must not let it, or any other run of code, through for good."""
    _, (a, _) = make_swarm_and_agents(client)
    pending = authorize(client, a, f'({skill} "invented argument")')
    assert pending["decision"] == "pending"
    always = decide(client, pending["approval_id"], "always")
    assert always.status_code == 400 and always.json()["error"]["code"] == "one_at_a_time"
    assert decide(client, pending["approval_id"], "once").json()["status"] == "approved"


def test_an_always_answered_before_shell_was_one_at_a_time_no_longer_stands(client):
    """A hive keeps the rules people's answers made, so an Always for shell from before this change would still let
    any shell command run; an answer's allow does not stand for an act approved one at a time."""
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.policy.add_rule(f"agent:{a['id']}", "shell", "allow", "always allowed when approving p_old",
                         origin=policy.ORIGIN_ANSWER)
    assert authorize(client, a, '(shell "ls")')["decision"] == "pending"
    hive.policy.add_rule(f"agent:{b['id']}", "shell", "allow", "an admin's rule for this mind")
    assert authorize(client, b, '(shell "ls")')["decision"] == "allow"    # a rule an admin sets still decides


def test_file_skills_hold_every_skill_whose_skill_args_take_a_path():
    """Each skill a SkillArg atom gives a "filepath" argument has the outside-folder check at that argument, save
    run-metta-file, which keeps its own path rule and asks every time."""
    declared = {}
    for path in [*ROOT.glob("hive/runtime/extensions/*.metta"), *ROOT.glob("modules/*/*.metta")]:
        for skill, position in PATH_ARG.findall(path.read_text()):
            declared[skill] = int(position) - 1
    assert len(declared) >= 12
    declared.pop("run-metta-file")
    assert {skill: policy.FILE_SKILLS.get(skill) for skill in declared} == declared
    assert policy.FILE_SKILLS["delete-file"] == 0   # Omega's own file skills, declared by add-skill


@pytest.mark.parametrize("command", [
    '(delete-file "/etc/hosts")',
    '(write-file-base64 "../other-mind/x" "eA==")',
    '(append-file-base64 "/tmp/x" "eA==")',
    '(send-file "/etc/passwd")',
    '(send-whatsapp-file-to "invented-chat@g.us" "/etc/passwd")',
    '(reply-whatsapp-file-caption-to "invented-chat@g.us" "../../secrets.json" "hi")',
])
def test_every_file_skill_keeps_its_path_inside_the_minds_folder(client, command):
    _, (a, _) = make_swarm_and_agents(client)
    refused = authorize(client, a, command)
    assert refused["decision"] == "deny" and "outside your own folder" in refused["message"], refused


@pytest.mark.parametrize("command,why", [
    ('(send-whatsapp-file-to "invented-chat@g.us" (car-atom ("/etc/passwd")))', "computed expression"),
    ('(send-whatsapp-file-to "invented-chat@g.us")', "no path argument"),
    ('(delete-file $path)', "variable"),
])
def test_a_file_skills_path_must_be_plain_text(client, command, why):
    _, (a, _) = make_swarm_and_agents(client)
    refused = authorize(client, a, command)
    assert refused["decision"] == "deny" and why in refused["message"], refused


def test_a_path_inside_the_minds_folder_still_reaches_the_policy(client):
    _, (a, _) = make_swarm_and_agents(client)
    assert authorize(client, a, '(delete-file "notes/old.txt")')["decision"] == "pending"
    assert authorize(client, a, '(send-whatsapp-file-to "invented-chat@g.us" "photo.jpg")')["decision"] == "pending"


@pytest.mark.parametrize("skill", PRIVATE_READS + ("persistent-expression", "body-container-launcher"))
def test_private_data_reads_and_the_other_named_heads_ask_a_person(client, skill):
    _, (a, _) = make_swarm_and_agents(client)
    assert authorize(client, a, f'({skill} "invented argument")')["decision"] == "pending"


def test_reboot_self_is_refused_unless_the_hive_is_the_minds_own_vm(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    refused = authorize(client, a, '(reboot-self "invented reason")')
    assert refused["decision"] == "deny" and "own VM" in refused["message"]
    hive.settings.embodied_vm = True
    try:
        pending = authorize(client, a, '(reboot-self "invented reason")')
        assert pending["decision"] == "pending"
        always = decide(client, pending["approval_id"], "always")
        assert always.status_code == 400 and always.json()["error"]["code"] == "one_at_a_time"
    finally:
        hive.settings.embodied_vm = False


def test_test_metta_stays_allowed_because_it_only_checks_syntax(client):
    """#299 counted test-metta as arbitrary MeTTa; it calls hive_helpers.test_metta_expression, which checks parentheses
    and quotes and evaluates nothing, so a shell command passes the check without running."""
    from hive.runtime.extensions.helper_metta import test_metta_expression
    _, (a, _) = make_swarm_and_agents(client)
    assert authorize(client, a, '(test-metta "(shell \\"rm -rf ~\\")")')["decision"] == "allow"
    assert test_metta_expression('(shell "rm -rf ~")') == "METTA-SYNTAX-OK"
    skills = (ROOT / "hive/runtime/extensions/skills_core.metta").read_text()
    assert "(= (test-metta $expr)\n   (py-call (hive_helpers.test_metta_expression $expr)))" in skills
