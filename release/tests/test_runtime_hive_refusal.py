"""Purpose: check that a model call the hive itself refused for spending or pace reaches the mind's wait as the hive's own
sentence and lasts the refusal's retry_after, while a provider's refusal keeps the fixed text and its 60 s retry."""
import json

import pytest

from hive.runtime import hive_services, provider_features
from hive.runtime.extensions import hive_helpers as helper


class SdkError(Exception):
    """An OpenAI SDK status error as Singnet's client raises it: body is the gateway's error object, response its HTTP."""
    def __init__(self, body, headers=None):
        super().__init__("Error code: 429")
        self.body = body
        self.response = type("Response", (), {"headers": dict(headers or {})})()


@pytest.fixture(autouse=True)
def clean():
    provider_features.take_refusal()
    yield
    provider_features.take_refusal()


def test_the_hive_s_own_refusal_is_kept_with_its_sentence_and_retry_after():
    say = "Spending faster than this month allows: a call this size fits again in about 21 minutes."
    provider_features.note_refusal(SdkError({"code": "spend_rate", "message": say, "say": say, "retry_after": 1260,
                                             "scope": "person:u_0a0b0c0d"}))
    assert provider_features.take_refusal() == (say, 1260)
    assert provider_features.take_refusal() is None                         # taking it clears it


def test_retry_after_comes_from_the_header_when_the_body_has_none_and_the_sentence_stays_one_plain_string():
    provider_features.note_refusal(SdkError({"code": "reservation_refused", "say": 'A "spending" limit (here) \\ no room.'},
                                            {"retry-after": "90"}))
    assert provider_features.take_refusal() == ("A spending limit here  no room.", 90.0)


@pytest.mark.parametrize("body", [{"code": "upstream_error", "message": "OpenRouter refused the request (rate limited, 429)."},
                                  {"message": "invented refusal", "type": "invented"}, "not json", None, {"say": "  "}])
def test_a_refusal_without_the_hive_s_sentence_is_not_kept(body):
    provider_features.note_refusal(SdkError(body))                          # a provider's own refusal, or none at all
    assert provider_features.take_refusal() is None


def test_a_hive_refusal_waits_its_retry_after_clamped_like_a_chosen_wait_and_sixty_seconds_without_one():
    wait = '((wait "Spending faster than this month allows: a call this size fits again in about 2 minutes."))'
    envelope = helper.prepare_model_response(wait, "hive")
    assert helper.prepared_response_kind(envelope) == "hive"
    commands = helper.prepared_response_commands(envelope)
    for given, chosen in ((120, 120), (5, 30), (10 ** 7, 86400), (0, 60)):
        assert helper.chosen_wait_seconds(commands, "hive", 0, given) == chosen, given
    hive_services._LAST_WAIT = None
    assert hive_services.last_wait_seconds() == 0           # a number for the loop to pass on, even when none was given
    hive_services._LAST_WAIT = 90.0
    assert hive_services.last_wait_seconds() == 90.0
    hive_services._LAST_WAIT = None
    assert helper.chosen_wait_seconds('((wait "LLM-PROVIDER-ERROR retry after 60 seconds"))', "provider") == 60
    assert json.loads(envelope)["retry_kind"] == "hive"
