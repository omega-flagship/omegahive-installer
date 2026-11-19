# Purpose: test that every refusal a model provider answers is a row of refusals.py's table, with the wait it asks for,
# and that a mind's call refused is kept on the mind: said in its view (its chat's notice) and in Health, held without
# asking the provider until its wait passes, and ended by someone writing to the mind, a change of the key its calls go
# out with, a new model or an answer, never by the mind's own work or someone else's key.
"""Provider refusals said to the person (the Windows tester's 402: a mind on a key with no credit retried every 60 s,
its chat showed nothing and Health said ok).

Synthetic minds and a scripted gateway: no network and no provider calls.
"""
import datetime
import email.utils
import re
import time

import httpx
import pytest

from hive.core import refusals
from hive.core.db import now
from hive.core.gateway import asked_wait, upstream_refusal
from hive.core.refusals import KINDS, REMEDIES, spoken
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

MODEL = "anthropic/claude-opus-5-5"   # priced in the default providers, so a call reaches the scripted provider
BODY = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 64}
ECHO = b'{"error":{"code":%d,"message":"echo sk-or-v1-' + b"a" * 40 + b' for user:u_bob"}}'


def _refusal(status, headers=None, provider="openrouter"):
    return upstream_refusal(provider, httpx.Response(status, headers=headers or {}, content=ECHO % status),
                            "anthropic/claude-sonnet-5.5")


# ---- the table: every status a provider refuses with ----------------------------------------------------------------

@pytest.mark.parametrize("status", range(400, 600))
def test_every_status_a_provider_refuses_with_is_a_row_written_for_the_person(status):
    err = _refusal(status)
    assert spoken(err) and err.code in KINDS and err.remedy in REMEDIES and err.status == status
    assert "sk-or" not in err.message and "u_bob" not in err.message and "{" not in err.message   # never its words


@pytest.mark.parametrize("status,code,remedy", [
    (402, "provider_no_credit", "credit"), (401, "provider_key_refused", "key"), (403, "provider_key_refused", "key"),
    (429, "provider_busy", "wait"), (408, "provider_unavailable", "wait"), (500, "provider_unavailable", "wait"),
    (503, "provider_unavailable", "wait"), (400, "provider_request_refused", "model"),
    (404, "provider_request_refused", "model"), (413, "provider_request_refused", "model"),
    (422, "provider_request_refused", "model"),
])
def test_each_status_category_says_what_the_person_can_do(status, code, remedy):
    err = _refusal(status)
    assert (err.code, err.remedy, err.retry_after) == (code, remedy, None)
    assert err.message.startswith("OpenRouter ")


def test_an_answer_asking_for_a_wait_is_busy_whatever_its_status():
    # OpenRouter sends Retry-After on a 402 whose in-flight budget is settling: a wait, not an empty account
    err = _refusal(402, {"retry-after": "12"})
    assert (err.code, err.remedy, err.retry_after) == ("provider_busy", "wait", 12.0)
    assert "tries again in 12 seconds" in err.message and "anthropic/claude-sonnet-5.5" in err.message


def test_the_refusal_keeps_what_billing_reads():
    # spoken or not, a refusal still tells billing what it told it before: OpenRouter's canonical 402 is released
    # unbilled, a 429 is not on the allowlist and stays unknown, and neither body reports a charge
    assert (_refusal(402).unbilled, _refusal(429).unbilled) == (True, False)
    assert _refusal(402).refusal_usage is None and _refusal(402).charge_usd is None


def test_asked_wait_reads_milliseconds_seconds_and_dates_and_nothing_else():
    later = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=90),
                                        usegmt=True)
    earlier = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=90),
                                          usegmt=True)
    assert asked_wait({"retry-after-ms": "1500", "retry-after": "9"}) == 1.5   # the finer one first
    assert asked_wait({"retry-after": "3"}) == 3.0
    assert asked_wait({"retry-after": str(10 * 365 * 86400)}) == 1800.0   # a wait of years is read as half an hour
    assert 85 < asked_wait({"retry-after": later}) <= 90
    for none in ({}, {"retry-after": "0"}, {"retry-after": "-4"}, {"retry-after": earlier}, {"retry-after": "soon"},
                 {"retry-after": "nan"}):
        assert asked_wait(none) is None, none


def test_openrouters_limit_reset_is_read_only_from_openrouter():
    reset = str(int((time.time() + 120) * 1000))   # milliseconds since the epoch, as OpenRouter sends it
    assert 115 < asked_wait({"x-ratelimit-reset": reset}, "openrouter") <= 120
    assert asked_wait({"x-ratelimit-reset": reset}, "anthropic") is None
    assert asked_wait({"x-ratelimit-reset": reset}) is None


@pytest.mark.parametrize("seconds,words", [(None, "shortly"), (0.2, "in 1 second"), (20, "in 20 seconds"),
                                           (60, "in about a minute"), (150, "in about 2 minutes"),
                                           (3600, "in about an hour"), (5400, "in about 2 hours")])
def test_when_a_mind_tries_again_in_words(seconds, words):
    assert refusals.when(seconds) == words


# ---- a mind's own calls: kept, said, held, ended ---------------------------------------------------------------------

def _mind(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=1.0)
    return a


def _provider(client, *answers):
    """The gateway's chat, scripted: each call takes the next answer (an exception is raised); returns the calls made."""
    calls = []
    queue = list(answers)

    async def chat(agent, body):
        calls.append(body)
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, BaseException):
            raise answer
        return answer
    client.app.state.gateway.chat = chat
    return calls


ANSWER = ({"id": "r1", "model": MODEL, "choices": [{"message": {"role": "assistant", "content": "hello"}}],
           "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
          {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.0001})


def _post(client, a):
    return client.post("/llm/v1/chat/completions", json=BODY, headers=agent_headers(a))


def test_a_402_is_said_kept_on_the_mind_and_counted_by_health(client):
    a = _mind(client)
    hive = client.app.state.hive
    _provider(client, _refusal(402))
    r = _post(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "provider_no_credit"
    assert r.json()["error"]["message"].startswith("OpenRouter says the account that pays for this mind has no credit")
    assert "retry-after" not in r.headers   # the provider named no wait; the mind's back-off is the hive's own
    refused = client.get(f"/api/agents/{a['id']}").json()["refused"]
    assert (refused["code"], refused["remedy"], refused["count"]) == ("provider_no_credit", "credit", 1)
    assert refused["say"] == r.json()["error"]["message"] and refused["retry_at"] > refused["since"]
    health = hive.health.mind(hive.agent(a["id"]))
    assert health["health"] == "high"
    issue = next(i for i in health["issues"] if i["kind"] == "refused-calls")
    assert refused["say"] in issue["example"]["result"] and issue["recent"]


def test_a_kept_refusal_answers_the_next_call_without_asking_the_provider(client):
    a = _mind(client)
    calls = _provider(client, _refusal(402))
    assert _post(client, a).status_code == 402
    again = _post(client, a)
    assert len(calls) == 1   # nothing sent the second time
    # held, it answers 429 with what is left of the wait, in the same words: a caller waits rather than reading a 402 as final
    assert again.status_code == 429 and again.json()["error"]["code"] == "provider_no_credit"
    assert 1 <= int(again.headers["retry-after"]) <= 60   # what is left of the first minute
    assert client.get(f"/api/agents/{a['id']}").json()["refused"]["count"] == 1   # a held call is no new refusal
    assert client.app.state.hive.db.all("SELECT * FROM cost_reservations WHERE state = 'held'") == []


def _write(client, a, text="are you there?"):
    """Someone writes to the mind, as a person does in its chat."""
    assert client.post(f"/api/agents/{a['id']}/messages", json={"text": text}).status_code == 200


def test_someone_writing_to_the_mind_ends_the_wait(client):
    # no pause between the refusal and the message: the release is the message itself, never a comparison of stamps
    a = _mind(client)
    calls = _provider(client, _refusal(402))
    _post(client, a)
    _write(client, a)
    refused = client.get(f"/api/agents/{a['id']}").json()["refused"]
    assert refused["count"] == 1 and refused["retry_at"] <= now()   # its view says it tries now, not in a minute
    assert _post(client, a).status_code == 402
    assert len(calls) == 2   # asked again at once
    assert client.get(f"/api/agents/{a['id']}").json()["refused"]["count"] == 2


def test_the_minds_own_work_never_ends_the_wait(client):
    # a mind that claims and heartbeats a task stamps its idle signal (Hive.mark_input), and that is no one writing to
    # it: keeping busy must not let it call a refusing provider sooner
    a = _mind(client)
    calls = _provider(client, _refusal(429, {"retry-after": "30"}))
    _post(client, a)
    goal = client.post("/api/agent/goals", json={"title": "Sort the notes"}, headers=agent_headers(a)).json()
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a)).status_code == 200
    assert client.post(f"/api/agent/goals/{goal['id']}/heartbeat", headers=agent_headers(a)).status_code == 200
    held = _post(client, a)
    assert held.status_code == 429 and len(calls) == 1   # still held: nothing sent
    assert 1 <= int(held.headers["retry-after"]) <= 30


def _keys_offline(monkeypatch):
    """A key is checked with its provider before it is stored: answered here, so a test adds keys offline."""
    from hive.core.providers import ProviderStore

    async def verify(self, name, key):
        return {"label": f"{name} key"}
    monkeypatch.setattr(ProviderStore, "verify", verify)


def test_a_key_added_for_someone_else_leaves_the_wait(client, monkeypatch):
    # the lens's case: a key change that leaves the key this mind's calls go out with as it was (an OpenAI key, then
    # another Anthropic key beside the default) must not send it back to its provider before its 30 minutes are up
    _keys_offline(monkeypatch)
    assert client.put("/api/providers/anthropic/key", json={"key": "sk-ant-default"}).status_code == 200
    a = _mind(client)
    calls = _provider(client, _refusal(429, {"retry-after": "1800"}))
    _post(client, a)
    assert client.post("/api/keys", json={"provider": "openai", "key": "sk-openai-other"}).status_code == 200
    assert client.post("/api/keys", json={"provider": "anthropic", "key": "sk-ant-other", "default": False}).status_code == 200
    held = _post(client, a)
    assert held.status_code == 429 and len(calls) == 1   # still held: nothing sent
    assert int(held.headers["retry-after"]) > 1700
    assert client.get(f"/api/agents/{a['id']}").json()["refused"]["code"] == "provider_busy"


def test_a_new_default_key_ends_the_wait(client, monkeypatch):
    # a mind on the provider's default pays with whatever key is the default: a new one (here set from the picker) is
    # not the key its account had no credit on, so the refusal goes and its next call asks the provider
    _keys_offline(monkeypatch)
    a = _mind(client)
    calls = _provider(client, _refusal(402))
    _post(client, a)
    assert client.put("/api/providers/anthropic/key", json={"key": "sk-ant-funded"}).status_code == 200
    assert client.get(f"/api/agents/{a['id']}").json()["refused"] is None
    assert _post(client, a).status_code == 402 and len(calls) == 2   # asked again with the new key


def test_a_refusal_that_lands_after_the_key_changed_holds_nothing(client, monkeypatch):
    # the lens's case at a27f2f8e: an admin made key B the default while a call on key A was out; A's 402 then landed.
    # It is A's refusal, and B was never refused, so nothing is kept and the next call goes out with B at once
    _keys_offline(monkeypatch)
    hive = client.app.state.hive
    assert client.put("/api/providers/anthropic/key", json={"key": "sk-ant-a"}).status_code == 200
    a = _mind(client)
    calls = []

    async def chat(agent, body):
        calls.append(body)
        if len(calls) == 1:
            await hive.providers.set_key("anthropic", "sk-ant-b")   # the new default lands while A's call is out
            raise _refusal(402)
        return ANSWER
    client.app.state.gateway.chat = chat
    assert _post(client, a).status_code == 402
    assert client.get(f"/api/agents/{a['id']}").json()["refused"] is None
    assert _post(client, a).status_code == 200 and len(calls) == 2


def test_another_key_for_the_mind_ends_the_wait(client, monkeypatch):
    # assigning a key announces no key change: the hold itself sees that the mind's calls now go out with another key
    _keys_offline(monkeypatch)
    assert client.put("/api/providers/anthropic/key", json={"key": "sk-ant-default"}).status_code == 200
    own = client.post("/api/keys", json={"provider": "anthropic", "key": "sk-ant-own", "default": False}).json()
    a = _mind(client)
    calls = _provider(client, _refusal(402))
    _post(client, a)
    assert client.patch(f"/api/agents/{a['id']}", json={"options": {"key": own["id"]}}).status_code == 200
    assert _post(client, a).status_code == 402 and len(calls) == 2   # asked again, with the mind's own key


def test_every_refusal_the_provider_answers_updates_the_minds_view(client, monkeypatch):
    # the chat's notice shows how many calls in a row were refused and when it tries again: both change each time
    a = _mind(client)
    hive = client.app.state.hive
    announced = []
    real = hive.emit_agent
    monkeypatch.setattr(hive, "emit_agent", lambda agent_id: (announced.append(
        (hive.model_refusals.get(agent_id) or {}).get("count")), real(agent_id))[1])
    _provider(client, _refusal(402))
    _post(client, a)
    _post(client, a)   # held: no new refusal, nothing to announce
    hive.model_refusals[a["id"]]["until"] = 0.0   # its wait passed
    _post(client, a)
    assert announced == [1, 2]


def test_another_model_ends_the_kept_refusal(client):
    a = _mind(client)
    calls = _provider(client, _refusal(402), ANSWER)
    _post(client, a)
    assert client.patch(f"/api/agents/{a['id']}", json={"model": "anthropic/claude-sonnet-5-5"}).status_code == 200
    assert client.get(f"/api/agents/{a['id']}").json()["refused"] is None   # not shown for a model it no longer has
    assert _post(client, a).status_code == 200 and len(calls) == 2


def test_an_answer_clears_it_and_health_reads_ok_again(client):
    a = _mind(client)
    hive = client.app.state.hive
    _provider(client, _refusal(402), ANSWER)
    _post(client, a)
    _write(client, a)
    assert _post(client, a).status_code == 200
    assert client.get(f"/api/agents/{a['id']}").json()["refused"] is None
    assert not any(i["kind"] in ("refused-calls", "held-calls") for i in hive.health.mind(hive.agent(a["id"]))["issues"])


def test_a_429_that_names_its_wait_is_held_that_long_and_reads_as_held_calls(client):
    a = _mind(client)
    hive = client.app.state.hive
    _provider(client, _refusal(429, {"retry-after": "30"}))
    r = _post(client, a)
    assert r.status_code == 429 and r.headers["retry-after"] == "30"
    assert "tries again in 30 seconds" in r.json()["error"]["message"]
    kept = hive.model_refusals[a["id"]]
    assert 25 < kept["until"] - time.monotonic() <= 30
    health = hive.health.mind(hive.agent(a["id"]))
    assert health["health"] == "medium" and any(i["kind"] == "held-calls" for i in health["issues"])


def test_a_providers_wait_of_years_holds_the_mind_half_an_hour(client):
    # Jon on #386: a huge Retry-After must not hold a mind for years. The asked wait is read as at most 30 minutes, and
    # the hold caps whatever wait a refusal carries
    a = _mind(client)
    hive = client.app.state.hive
    _provider(client, _refusal(429, {"retry-after": str(10 * 365 * 86400)}))
    r = _post(client, a)
    assert r.status_code == 429 and r.headers["retry-after"] == "1800"
    assert "tries again in about 30 minutes" in r.json()["error"]["message"]
    hive.note_model_refusal(hive.agent(a["id"]), refusals.refused("provider_busy", 429, retry_after=10 ** 9,
                                                                  provider="OpenRouter", model="m", when="later"))
    assert 1790 < hive.model_refusals[a["id"]]["until"] - time.monotonic() <= 1800


def test_the_hives_own_limits_answer_before_a_kept_refusal(client):
    # Jon on #386: a spending limit (here no budget) is the hive's own rule, so it answers in its own words, and a kept
    # provider refusal holds only what would be sent
    a = _mind(client)
    calls = _provider(client, _refusal(402))
    _post(client, a)
    client.app.state.hive.db.execute("UPDATE agents SET budget_usd = 0 WHERE id = ?", (a["id"],))
    r = _post(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "no_budget" and len(calls) == 1


def test_a_day_used_up_is_said_to_its_person_and_shown_on_the_mind_in_words_for_everyone(client):
    # Jon on #386: everyone who can see a mind reads the refusal kept on it, so "You've used today's free calls" is the
    # answer to the call alone, and the mind's view says it of the mind's person
    a = _mind(client)

    def estimate(agent, body, allow_unpriced=False, principal=None):
        raise refusals.refused("free_inference_daily_cap", 429, retry_after=3600, limit=200)
    client.app.state.gateway.estimate = estimate
    r = _post(client, a)
    assert r.status_code == 429 and r.json()["error"]["message"].startswith("You've used today's 200 free model calls")
    refused = client.get(f"/api/agents/{a['id']}").json()["refused"]
    assert refused["say"].startswith("This mind's person has used today's 200 free model calls")
    assert refused["retry_at"] is None   # the hive's own rule: no wait is kept, so no time is named


def test_a_sentence_for_one_person_has_words_for_the_mind_that_speak_to_no_one():
    for code, kind in KINDS.items():
        if kind.mind_say:
            words = kind.mind_say.format(limit=200)
            assert not re.search(r"\byou", words, re.IGNORECASE), (code, words)
    assert {c for c, k in KINDS.items() if k.mind_say} == {"free_inference_daily_cap", "free_inference_invited_only"}


def test_each_refusal_in_a_row_waits_twice_as_long_up_to_half_an_hour(client):
    a = _mind(client)
    hive = client.app.state.hive
    agent = hive.agent(a["id"])
    waits = []
    for _ in range(7):
        hive.note_model_refusal(agent, _refusal(402))
        waits.append(round(hive.model_refusals[a["id"]]["until"] - time.monotonic()))
    assert waits == [60, 120, 240, 480, 960, 1800, 1800]


def test_a_refusal_the_table_lacks_is_not_kept(client):
    a = _mind(client)
    from hive.core.gateway import GatewayError
    _provider(client, GatewayError(400, "bad_model", "model must be <provider>/<model>"))
    assert _post(client, a).status_code == 400
    assert client.get(f"/api/agents/{a['id']}").json()["refused"] is None


def test_the_hives_own_refusal_is_kept_but_never_holds_the_next_call(client):
    # a held $0 model is refused by the hive's own rule, with nothing sent: asking again costs nothing and is answered
    # by that rule at once, so the mind's chat says why while its calls still reach the rule each time
    a = _mind(client)
    asked = []

    def estimate(agent, body, allow_unpriced=False, principal=None):
        asked.append(body)
        raise refusals.refused("free_model_unreconciled", 402, model="openrouter/google/gemma-4-31b-it:free")
    client.app.state.gateway.estimate = estimate
    for _ in range(2):
        r = _post(client, a)
        assert r.status_code == 402 and r.json()["error"]["code"] == "free_model_unreconciled"
        assert "retry-after" not in r.headers
    assert len(asked) == 2   # the second call asked the rule again
    refused = client.get(f"/api/agents/{a['id']}").json()["refused"]
    assert (refused["code"], refused["remedy"], refused["count"]) == ("free_model_unreconciled", "model", 2)
    assert refused["retry_at"] is None   # no wait is kept, so its chat names no time to try again
