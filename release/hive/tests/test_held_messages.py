"""Purpose: check that a mind reports a result only once it has come back, and that its person waits one extra turn at
most. Jon on omega-flagship/omegahive#334: "a mind should report a result only after it comes back. The extra turn is
fine." A reply's commands run in order and their results reach the mind only on its next turn, so a message written
after another command in the same reply is held: it runs as held-message, which sends nothing and says why. A message
before any command, or after only messages and waits, goes out as before, and so does every message of the reply right
after a hold (Jon on #334: "Could a message that was held once go out the next time it's written?").
tests/test_wait_quiet_runtime.py checks the same on the real runtime, what the person gets included."""
import itertools
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


def reply(source, last="clear", failure="normal"):
    """One turn as the loop runs it (loop_hooks.metta hive-run-response): the commands that run, and the &lastReplyHold
    the next turn gets."""
    envelope = helper.prepare_model_response(source, failure, last)
    return helper.prepared_response_commands(envelope), helper.prepared_response_hold(envelope, last)


def test_a_mind_pairing_a_command_with_a_message_every_turn_gets_every_other_message_out():
    last, got = "clear", []
    for turn in range(1, 5):
        ran, last = reply(f'remember "lesson {turn}"\nsend "turn {turn}"', last)
        got.append("held" if "held-message" in ran else "sent")
    assert got == ["held", "sent", "held", "sent"]


def test_the_reply_right_after_a_hold_sends_every_message_where_it_stands():
    source = 'hive-goals\nsend "you have two"\nremember "told them"\nsend-hive-to c_1 "and to you"'
    assert reply(source, "held") == (helper.signature_balance_parentheses(source), "clear")
    ran, last = reply(source, "clear")
    assert ran.count("(held-message ") == 2 and last == "held"


# A turn the runtime ran none of (a malformed reply, a provider failure) keeps the last hold, so it can't open the way
# for a second hold in a row.
SHAPES = {
    "acts, then speaks": ('remember "x"\nsend "a"', "normal"),
    "speaks, then acts": ('send "a"\nremember "x"', "normal"),
    "only speaks": ('send "a"', "normal"),
    "only acts": ('remember "x"', "normal"),
    "waits": ("wait 60 nothing new", "normal"),
    "malformed": ('send "a"\nread-file', "normal"),
    "provider failure": ('remember "x"\nsend "a"', "provider"),
}


def test_no_message_is_held_twice_in_a_row_whatever_the_turns_between():
    """Every sequence of five turns over SHAPES (7^5 = 16,807, each turn parsed at most twice): a reply holds a message
    only when the last reply the runtime ran held none, the one after a hold sends every message, a hold still comes
    whenever it may, and a turn the runtime ran none of keeps the last hold."""
    for turns in itertools.product(SHAPES, repeat=5):
        last = "clear"
        for name in turns:
            source, failure = SHAPES[name]
            ran, after = reply(source, last, failure)
            held = "(held-message " in ran
            assert not (held and last == "held"), turns
            if name == "acts, then speaks":
                assert held == (last == "clear"), turns
            ran_none = failure == "provider" or ran.startswith('((wait "LLM-FORMAT-ERROR')
            assert after == (last if ran_none else "held" if held else "clear"), turns
            last = after
