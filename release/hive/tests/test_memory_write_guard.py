"""Purpose: a mind's memory-writing call with nothing to write is refused before it runs, with what the skill needs, so
the mind sends it again with content on its next turn. On v0.33 probe3 one mind's reply ran remember "", belief-claim ""
and pin "": remember stored an empty memory and pin answered PIN-SUCCESS, while belief-claim refused with a shape
warning. The skills covered are those the runtime's affordance files declare as writing memory."""

import pytest

from hive.runtime import hive_services
from hive.spaces import sexpr


def refused(command):
    """The refusal's text when the command runs as (hive-refused "<text>"), else None."""
    out = sexpr.parse(hive_services.checked_command_expr(command))
    return str(out[1]) if isinstance(out, list) and out[:1] == ["hive-refused"] else None


def test_the_three_empty_calls_from_probe3_are_refused_with_what_each_needs():
    assert refused('(remember "")') == ('REMEMBER-REFUSED: nothing was written, since remember was sent nothing. Send '
                                       'it again with its lesson, as remember lesson')
    assert "with its domain relation value frequency confidence, as belief-claim domain relation" in refused('(belief-claim "")')
    assert refused('(pin "")').startswith('PIN-REFUSED: nothing was written, since pin was sent nothing. Send it again '
                                          'with its state')


def test_every_memory_write_with_nothing_or_only_whitespace_is_refused():
    assert {"remember", "pin", "belief-claim", "belief-derived", "persistent-note", "persistent-fact", "world-fact",
            "event-note", "agenda-goal", "assimilate-belief"} <= set(hive_services.MEMORY_WRITES)
    for skill in hive_services.MEMORY_WRITES:
        for command in (f"({skill})", f'({skill} "")', f'({skill} "   ")', f'({skill} "" " ")', f'({skill} "\\n")'):
            out = refused(command)   # sexpr.parse reads it as PeTTa does: one string, no double quote inside
            assert out and out.startswith(f"{skill.upper()}-REFUSED: "), command


@pytest.mark.parametrize("command", ['(remember "tea at four")', '(pin "task -> next | none")', '(send "")',
                                     '(belief-claim "sky color blue 1.0 0.9")', '(remember tea)', "(wait)"])
def test_a_call_with_something_in_it_or_another_skill_runs_as_before(command):
    assert hive_services.checked_command_expr(command) == hive_services.command_expr(command)


def test_the_loop_runs_every_command_through_the_guard_and_gives_a_refusal_back_as_its_result():
    loop = (hive_services.ROOT / "hive/runtime/extensions/loop_hooks.metta").read_text()
    assert "(hive_services.checked_command_expr (repr $cmd))" in loop and "(hive_services.command_expr " not in loop
    assert "(= (hive-refused $text) $text)" in loop
