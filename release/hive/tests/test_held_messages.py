"""Purpose: check that a mind reports a result only once it has come back. Jon on omega-flagship/omegahive#334: "a mind
should report a result only after it comes back. The extra turn is fine." A reply's commands run in order and their
results reach the mind only on its next turn, so a message written after another command in the same reply is held: it
runs as held-message, which sends nothing and says why. A message before any command, or after only messages and waits,
goes out as before. tests/test_wait_quiet_runtime.py checks the same on the real runtime, what the person gets
included."""
import json
import pathlib
import sys

import pytest

from hive.runtime.extensions import hive_helpers as helper

ROOT = pathlib.Path(__file__).resolve().parents[2]   # hive/tests/ -> the repository's root


def commands(source):
    envelope = helper.prepare_model_response(source)
    assert json.loads(envelope)["retry_kind"] == "normal"
    return helper.prepared_response_commands(envelope)


@pytest.mark.parametrize("source, expected", [
    # the v0.30 case: a share, and "Shared" written before the share's result came back
    ('hive-publish (--> sky blue) 0.9 0.8\nsend Shared it',
     '((hive-publish "(--> sky blue)" 0.9 0.8) (held-message send "Shared it"))'),
    # every message skill, and every message after the first command, whatever comes between
    ('remember "a lesson"\nsend-hive-to c_1 saved it\nwait 60 done\nhive-room-post r_1 @Ann saved it',
     '((remember "a lesson") (held-message send-hive-to "c_1" "saved it") (wait "60 done") '
     '(held-message hive-room-post "r_1" "@Ann saved it"))'),
    # said first, then acted, then reported: only the report waits
    ('send "on it"\nhive-goals\nsend "you have two"',
     '((send "on it") (hive-goals) (held-message send "you have two"))'),
])
def test_a_message_after_another_command_is_held_until_its_result_is_back(source, expected):
    assert commands(source) == expected


@pytest.mark.parametrize("source", [
    'send "on it"\nhive-goals',                  # said before acting: an intention, not a result
    'send "one"\nsend "two"\nwait 60 done',      # only messages and a wait
    'wait 60 nothing new\nsend "still here"',    # a wait has no result to report
    'hive-goals',                                # no message at all
])
def test_a_message_before_any_command_or_after_only_messages_and_waits_goes_out(source):
    assert commands(source) == helper.signature_balance_parentheses(source)
    assert "held-message" not in commands(source)


def test_a_held_message_says_why_and_reads_as_neither_an_error_nor_a_refusal():
    note = helper.held_message_note("send")
    # what the mind sends next is news to its person: a team mind told only that nobody had seen the held words still
    # wrote "One correction to my earlier note" about them
    assert note == ("NOT SENT, so nobody has seen it: this send came after another command in the same reply, so it waited for that "
                    "command's result. Read the results, then send what actually happened as the first the person hears "
                    "of it, not as a correction of a message they never got.")
    from hive.core import health   # Health groups command results by kind; a held message is not a problem
    assert health.classify('(held-message send "Shared it")', note) is None


def test_held_message_runs_without_the_gate_for_every_message_skills_arity():
    sys.path.insert(0, str(ROOT / "modules" / "hive" / "src"))
    try:
        import hive_commons
    finally:
        sys.path.remove(str(ROOT / "modules" / "hive" / "src"))
    assert "held-message" in hive_commons.LOCAL_ALLOW        # it sends nothing, so no policy is asked
    assert hive_commons.authorize('(held-message send "Shared it")') is True
    skills = (ROOT / "hive" / "runtime" / "extensions" / "skills_core.metta").read_text(encoding="utf-8")
    # send takes one argument, send-hive-to and hive-room-post two; held, each gains the skill's name
    for head in ("(held-message $skill)", "(held-message $skill $a)", "(held-message $skill $a $b)"):
        assert f"(= {head}\n   (py-call (hive_helpers.held_message_note $skill)))" in skills, head


def test_the_omega_prompt_tells_minds_a_message_after_a_command_is_held():
    prompt = (ROOT / "hive" / "templates" / "omega" / "prompt.txt").read_text(encoding="utf-8")
    assert ("Commands run in order and their results reach you only on your next turn, so a message after another "
            "command in the same reply is held, not sent: say what a command did in your next reply, once its result "
            "shows.") in prompt
