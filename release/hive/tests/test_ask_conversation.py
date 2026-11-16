"""Purpose: the Ask's conversation so far reaches whichever mind answers (Jon, 16 Nov: "context and continuity are
consistently persistent regardless of which model you interact", "without needing additional LLM calls to pass through
convo").

Invented lives only: Ann (user:u_ann) and her own mind, renamed Taiga here; the test world's swarm Home with its
coordinator Orchestra and a mind called Worker; Bob (user:u_bob) and his own mind.
- a conductor turn routed to a swarm reads the conversation her browser sent, with HIVE_ASK_MEMORY unset, as one
  transcript naming each speaker: "you" for the mind answering now, Worker by name, oldest first, with how long ago;
- a turn with her own mind reads it too, and her own mind is "you" there;
- a mind she can't see, another person's own mind, or an id the page made up is only "a mind";
- an exchange naming a private app never reaches the model; nothing of it is stored or logged, only a count and a digest;
- the shape is checked before anything is written, with the conductor on or off.
"""
import json
import logging
import time

import pytest

from hive.core import conductor as cmod
from hive.tests.test_ask import ask, counts
from hive.tests.test_ask_conductor import Script, closed, dump, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_ask import _on

CODE = "my code word is HEMLOCK-SEVEN"


def _taiga(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    hive.db.execute("UPDATE agents SET name = 'Taiga' WHERE id = ?", (w["mine"]["id"],))
    # the coordinator answers on the host's priced key (_on): a $5 cap of its own, so a swarm turn reaches the model
    hive.db.execute("UPDATE agents SET budget_usd = 5 WHERE id = ?", (w["coord"]["id"],))
    return w


def _ago(minutes):
    return time.time() * 1000 - minutes * 60_000


def _context(body):
    return body["messages"][1]["content"]


def test_a_swarm_turn_reads_the_conversation_naming_each_speaker_with_memory_off(client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    w = _taiga(client, monkeypatch)
    hive = w["hive"]
    conversation = [
        {"said": CODE, "answer": "Got it, HEMLOCK-SEVEN it is.", "by": w["mine"]["id"], "at": _ago(180)},
        {"said": "what does Worker build?", "answer": "Worker builds the garden planner.", "by": w["worker"]["id"], "at": _ago(0.5)},
    ]
    s = script(client, Script("It's HEMLOCK-SEVEN."))
    r = ask(client, w["ann"], "op-conv-swarm-01", text="what was my code word?", context={"swarm_id": w["swarm"]["id"]},
            conversation=conversation)
    assert r.status_code == 202, r.text
    assert r.json()["thread"]["mind"]["id"] == w["coord"]["id"]          # routed to the swarm's coordinator, as before
    wait(hive, "op-conv-swarm-01", closed)
    context = _context(s.bodies[0])
    transcript = context[context.index("The conversation so far in the Ask"):]
    assert transcript.index(CODE) < transcript.index("what does Worker build?")   # oldest first
    assert "- 3 hours ago, they said: “my code word is HEMLOCK-SEVEN”\n  you answered: “Got it, HEMLOCK-SEVEN it is.”" in transcript
    assert "- just now, they said: “what does Worker build?”\n  Worker answered: “Worker builds the garden planner.”" in transcript
    # the person's words for this turn stay the user message; the transcript is context, never instructions
    assert s.bodies[0]["messages"][2] == {"role": "user", "content": "what was my code word?"}
    # held by the turn only: no row and no log line carries the carried words (a swarm turn's own answer is its room's,
    # as before); the log has a count and a digest
    stored = dump(hive)
    for words in (CODE, "Got it, HEMLOCK-SEVEN it is.", "what does Worker build?", "garden planner"):
        assert words not in stored and words not in caplog.text
    assert f"carries 2 earlier exchanges (digest {cmod.conversation_digest(conversation)})" in caplog.text
    # the next turn without it has none
    s2 = script(client, Script("Hi."))
    ask(client, w["ann"], "op-conv-swarm-02", text="hello", context={"swarm_id": w["swarm"]["id"]})
    wait(hive, "op-conv-swarm-02", closed)
    assert "HEMLOCK" not in json.dumps(s2.bodies[0]) and "The conversation so far" not in _context(s2.bodies[0])


def test_a_turn_with_her_own_mind_reads_it_and_names_another_mind_by_name(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    hive = w["hive"]
    conversation = [{"said": "what does Worker build?", "answer": "The garden planner.", "by": w["worker"]["id"], "at": _ago(10)},
                    {"said": CODE, "answer": "Noted.", "by": w["mine"]["id"], "at": _ago(2)}]
    s = script(client, Script("HEMLOCK-SEVEN."))
    r = ask(client, w["ann"], "op-conv-own-01", text="and my code word?", conversation=conversation)
    assert r.status_code == 202 and r.json()["acting_as"]["name"] == "Taiga"
    wait(hive, "op-conv-own-01", closed)
    transcript = _context(s.bodies[0])
    # her own mind is told its memory is this conversation, and not to warn her it may forget (it carries on)
    system = s.bodies[0]["messages"][0]["content"][0]["text"]
    assert "the conversation so far in the Ask, whichever mind answered in it" in system and "may be forgotten" in system
    assert "- 10 minutes ago, they said: “what does Worker build?”\n  Worker answered: “The garden planner.”" in transcript
    assert "- 2 minutes ago, they said: “my code word is HEMLOCK-SEVEN”\n  you answered: “Noted.”" in transcript


def test_a_mind_she_cannot_name_is_only_a_mind(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    hive = w["hive"]
    bobs = hive.personal.ensure("user:u_bob")
    hive.db.execute("UPDATE agents SET name = 'Bobsmind' WHERE id = ?", (bobs["id"],))
    hidden = client.post("/api/agents", json={"name": "Hushed", "swarm_id": w["swarm"]["id"]}).json()
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = ?", (hidden["id"],))
    conversation = [{"said": "one", "answer": "first answer", "by": bobs["id"], "at": _ago(5)},
                    {"said": "two", "answer": "second answer", "by": hidden["id"], "at": _ago(4)},
                    {"said": "three", "answer": "third answer", "by": "a_madeup01", "at": _ago(3)}]
    s = script(client, Script("Ok."))
    ask(client, w["ann"], "op-conv-names-1", text="hi", context={"swarm_id": w["swarm"]["id"]}, conversation=conversation)
    wait(hive, "op-conv-names-1", closed)
    transcript = _context(s.bodies[0])
    for answer in ("first answer", "second answer", "third answer"):
        assert f"a mind answered: “{answer}”" in transcript
    assert "Bobsmind" not in transcript and "Hushed" not in transcript


def test_an_exchange_naming_a_private_app_never_reaches_the_model(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    hive = w["hive"]
    conversation = [{"said": "how did I sleep per Atlas?", "answer": "Atlas says seven hours.", "by": w["mine"]["id"], "at": _ago(9)},
                    {"said": CODE, "answer": "Noted.", "by": w["mine"]["id"], "at": _ago(8)}]
    s = script(client, Script("Ok."))
    ask(client, w["ann"], "op-conv-priv-01", text="hi", conversation=conversation)
    wait(hive, "op-conv-priv-01", closed)
    context = _context(s.bodies[0])
    assert "HEMLOCK-SEVEN" in context and "Atlas" not in context and "seven hours" not in context


BAD = [
    [{"said": "a", "answer": "b", "by": "a_x", "at": 1}] * 9,                                 # more than 8
    [{"said": "a", "answer": "b", "by": "a_x"}],                                               # no time
    [{"said": "a", "answer": "b", "by": "a_x", "at": 1, "who": "Taiga"}],                      # a key it doesn't take
    [{"said": " ", "answer": "b", "by": "a_x", "at": 1}],                                      # empty words
    [{"said": "a", "answer": "", "by": "a_x", "at": 1}],                                       # empty answer
    [{"said": "a", "answer": "b", "by": "a x", "at": 1}],                                      # not a mind id
    [{"said": "a", "answer": "b", "by": "a_x", "at": -1}],                                     # before the epoch
    [{"said": "a", "answer": "b", "by": "a_x", "at": True}],                                   # a flag, not a time
    [{"said": "a", "answer": "b", "by": "a_x", "at": "1"}],                                    # text, not a time
    [{"said": "x" * 4500, "answer": "y" * 4000, "by": "a_x", "at": 1}],                        # over 8 KB
    "a string", {"said": "a"}, [3],
]


@pytest.mark.parametrize("conductor", [True, False])
def test_the_shape_is_checked_before_anything_is_written(client, monkeypatch, conductor):
    w = _on(client, monkeypatch, conductor=conductor)
    hive = w["hive"]
    before = counts(hive)
    for i, bad in enumerate(BAD):
        r = ask(client, w["ann"], f"op-conv-bad-{i:03d}", context={"swarm_id": w["swarm"]["id"]}, conversation=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", bad
    assert counts(hive) == before
    # the largest allowed shape is taken, the conductor on or off
    if conductor:
        script(client, Script("Ok."))
    ok = [{"said": "s" * 450, "answer": "a" * 450, "by": w["mine"]["id"], "at": _ago(1)}] * 8
    r = ask(client, w["ann"], "op-conv-good-01", context={"swarm_id": w["swarm"]["id"]}, conversation=ok)
    assert r.status_code == 202, r.text


def test_half_a_character_is_refused_never_a_server_error(client, monkeypatch):
    """A page that cut an emoji in two sends a lone surrogate (JSON escapes it); it is not text, so the Ask refuses it
    as invalid, for the notes as for the conversation, instead of failing with a server error."""
    w = _on(client, monkeypatch)
    half = "\ud83d"   # the first half of 😀, as the browser's JSON.stringify escapes it
    for i, extra in enumerate(({"memory_notes": [f"likes {half}"]},
                               {"conversation": [{"said": f"hi {half}", "answer": "ok", "by": w["mine"]["id"], "at": 1}]})):
        body = {"operation_id": f"op-conv-half-{i}", "text": "hi", "context": {"swarm_id": w["swarm"]["id"]}, **extra}
        r = client.post("/api/ask", headers={**w["ann"], "content-type": "application/json"}, content=json.dumps(body))
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", r.text


def test_how_long_ago_reads_coarsely_and_a_fast_clock_reads_just_now():
    minute = 60_000
    assert [cmod._ago(m * minute) for m in (-5, 0, 1.4, 2, 89, 91, 35 * 60, 37 * 60, 3 * 1440)] == [
        "just now", "just now", "just now", "2 minutes ago", "89 minutes ago", "2 hours ago", "35 hours ago", "2 days ago",
        "3 days ago"]
