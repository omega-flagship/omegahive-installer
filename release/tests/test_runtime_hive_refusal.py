"""Purpose: verify that a spending-limit refusal reaches a mind as the hive's sentence with the usual backoff."""
import pytest

from hive.runtime import provider_features


class SdkError(Exception):
    """An OpenAI SDK status error as Singnet's client raises it: body is the gateway's error object."""
    def __init__(self, body):
        super().__init__("Error code: 402")
        self.body = body


@pytest.fixture(autouse=True)
def clean():
    provider_features.take_refusal()
    yield
    provider_features.take_refusal()


def test_the_hive_s_own_refusal_is_kept_with_its_sentence():
    say = "A spending limit has no room for this call."
    provider_features.note_refusal(SdkError({"code": "spend_limit", "message": say, "say": say,
                                             "scope": "person:u_0a0b0c0d"}))
    assert provider_features.take_refusal() == say
    assert provider_features.take_refusal() is None


def test_the_hive_s_sentence_stays_one_plain_string():
    provider_features.note_refusal(SdkError({"code": "reservation_refused", "say": 'A "spending" limit (here) \\ no room.'}))
    assert provider_features.take_refusal() == "A spending limit here  no room."


@pytest.mark.parametrize("body", [{"code": "upstream_error", "message": "OpenRouter refused the request (rate limited, 429)."},
                                  {"message": "invented refusal", "type": "invented"}, "not json", None, {"say": "  "}])
def test_a_refusal_without_the_hive_s_sentence_is_not_kept(body):
    provider_features.note_refusal(SdkError(body))                          # a provider's own refusal, or none at all
    assert provider_features.take_refusal() is None
