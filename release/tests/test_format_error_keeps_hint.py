"""A malformed command's parser recovery text survives into the format-error wait, so the next turn can fix it."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import helper


def test_missing_argument_hint_survives():
    commands, kind = helper._model_response('((hive-goal-get "g1") (code-mind-work "rq_1"))')
    assert kind == "format"
    assert commands.startswith('((wait "LLM-FORMAT-ERROR retry with complete skill commands; ')
    assert "missing team" in commands and commands.count('"') == 2


def test_incomplete_batch_keeps_plain_marker():
    commands, kind = helper._model_response('((hive-goal-get "g1"')
    assert kind == "format" and commands == '((wait "LLM-FORMAT-ERROR retry with complete skill commands"))'


def test_well_formed_unchanged():
    assert helper._model_response('((hive-goal-get "g1"))') == ('((hive-goal-get "g1"))', "normal")
