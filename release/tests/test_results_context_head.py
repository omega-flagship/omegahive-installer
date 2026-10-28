from src import helper_metta


def test_long_result_keeps_its_identifying_header_and_its_end():
    header = "HIVE-REVISION ar_71407f34 r1 sha256:" + "3" * 64
    text = "((COMMAND_RETURN: ((hive-revision-read ar_71407f34 1) \"" + header + " " + "{\\\"k\\\": 1} " * 900 + "END\")))"
    view = helper_metta.context_last_results(text, 5000)
    assert header in view and view.rstrip().endswith("END\")))")
    assert "RESULTS-CONTEXT-TRUNCATED" in view and len(view) < 5000 + 200


def test_short_results_are_untouched():
    assert helper_metta.context_last_results("((COMMAND_RETURN: (x ok)))", 5000) == "((COMMAND_RETURN: (x ok)))"
