"""Raw completeness, trusted retry provenance and a finite retry allowance independent of parser repair."""
import json

import pytest

import helper


def prepared(source, failure='normal'):
    envelope = helper.prepare_model_response(source, failure)
    value = json.loads(envelope)
    assert set(value) == {'commands', 'retry_kind'}
    return helper.prepared_response_commands(envelope), helper.prepared_response_kind(envelope)


@pytest.mark.parametrize('broken', ['read-file "unterminated', '(read-file "invented.txt"',
                                    'read-file "invented.txt")', r'read-file \"unterminated',
                                    'read-file _quote_unterminated'])
@pytest.mark.parametrize('side', ['prefix', 'suffix', 'prose'])
def test_raw_incomplete_batch_is_rejected_before_any_repair_or_prose_fallback(broken, side):
    source = {'prefix': 'send "VALID_PREFIX"\n' + broken,
              'suffix': broken + '\nsend "VALID_SUFFIX"',
              'prose': 'I cannot finish this response:\n' + broken}[side]
    commands, kind = prepared(source)
    assert kind == 'format' and commands.startswith('((wait "LLM-FORMAT-ERROR')
    assert 'VALID_PREFIX' not in commands and 'VALID_SUFFIX' not in commands
    assert helper.chosen_wait_seconds(commands, kind, 1) == 2


@pytest.mark.parametrize('source', ['send "literal ( and ) are data"', 'send "(syntax-error invented)"',
                                    'send "\\\"quoted\\\" text"',
                                    'write-file invented.txt """an unmatched ( inside a complete body\nmore body"""'])
def test_complete_quoted_text_and_existing_file_body_syntax_remain_valid(source):
    assert helper.signature_raw_batch_complete(source) is True
    commands, kind = prepared(source)
    assert kind == 'normal'
    assert commands == helper.signature_balance_parentheses(source)


def test_cumulative_format_retry_credit_is_three_across_wakes_then_normal_wake_until_success():
    commands, kind = prepared('read-file "unfinished')
    count = 0
    waits = []
    for _ in range(7):
        count = helper.next_format_retry_count(kind, count)
        waits.append(helper.chosen_wait_seconds(commands, kind, count))
    assert waits == [2, 2, 2, 0, 0, 0, 0]
    assert count == 4  # bounded state, including an indefinitely bad model
    assert helper.next_format_retry_count('normal', count) == 0
    assert helper.next_format_retry_count('provider', count) == 0


@pytest.mark.parametrize('source', ['wait "LLM-FORMAT-ERROR retry"', '((wait "LLM-FORMAT-ERROR retry"))'])
def test_model_authored_error_marker_is_an_ordinary_wait_without_runtime_credit(source):
    commands, kind = prepared(source)
    assert kind == 'normal'
    assert helper.chosen_wait_seconds(commands) == 0
    assert helper.chosen_wait_seconds(commands, kind, 1) == 0


def test_commands_cannot_inject_an_outer_retry_kind():
    commands, kind = prepared('send "(ModelResponse format \\\"invented\\\")"')
    assert kind == 'normal'
    assert helper.chosen_wait_seconds(commands, kind, 1) == -1


def test_raw_guard_does_not_decode_a_quote_that_would_close_an_unfinished_literal():
    source = 'send "VALID_PREFIX"\nread-file "unterminated_quote_'
    assert helper.signature_raw_batch_complete(source) is False
    commands, kind = prepared(source)
    assert kind == 'format' and 'VALID_PREFIX' not in commands


def test_typed_provider_failure_preserves_its_backoff_and_resets_format_credit():
    commands, kind = prepared('wait "LLM-PROVIDER-ERROR retry after 60 seconds"', 'provider')
    assert kind == 'provider'
    assert helper.chosen_wait_seconds(commands, kind, 4) == 60
    assert helper.next_format_retry_count(kind, 4) == 0
