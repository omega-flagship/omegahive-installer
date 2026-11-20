"""A malformed command's parser recovery text survives into the format-error wait, so the next turn can fix it."""
from hive.runtime.extensions import hive_helpers as helper


def test_missing_argument_hint_survives():
    commands, kind = helper._model_response('((hive-goal-get "g1") (code-mind-work "rq_1"))')
    assert kind == "format"
    assert commands.startswith('((wait "LLM-FORMAT-ERROR retry with complete skill commands; ')
    assert "missing team" in commands and commands.count('"') == 2


def test_incomplete_batch_keeps_plain_marker():
    commands, kind = helper._model_response('((hive-goal-get "g1"')
    assert kind == "format" and commands == '((wait "LLM-FORMAT-ERROR retry with complete skill commands"))'


def test_an_unclosed_body_names_the_line_it_lacks():
    """Jon's review of #497 (P2): a reply that wasn't cut off but left a file's body open is refused whole, and the
    retry is told which body never closed, so it closes it instead of sending the same reply again."""
    commands, kind = helper._model_response("hive-goal-file g_1 notes.txt <<'EOF_n'\nhello")
    assert kind == "format"
    assert commands == ('((wait "LLM-FORMAT-ERROR retry with complete skill commands; a body opened with '
                        "<<'EOF_n' has no line EOF_n to close it\"))")


def test_well_formed_unchanged():
    assert helper._model_response('((hive-goal-get "g1"))') == ('((hive-goal-get "g1"))', "normal")
