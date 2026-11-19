"""Purpose: a Continue's model is told the request it continues from the hive's own record (Haley, testers' group,
19 Nov, on v0.38: her request in Create · Code's thread stopped at the two-minute limit, and her Continue was answered
"I'm not sure what to continue").

Invented lives only: Ann (user:u_ann) and her own mind, renamed Taiga here; the test world's swarm Home with its
coordinator Orchestra.
- a Continue in a swarm's thread reads the stopped request's words and its answer when it stopped, from the host's own
  record, while the exchange her browser kept (under Taiga, who spoke) still stays out of that swarm's turn;
- a Continue of a Continue reads the first request's words and the latest answer, and how often it was continued, as
  each Continue on the way was told the ones before it;
- a Continue with her own mind gets no words from the host, which kept none, and is pointed at her browser's copy;
- a turn whose thread she deleted gives nothing of its words back; the log has ids only.
What was handed over is in test_ask_intents.py, beside the guard that refuses a repeat.
"""
import logging

from hive.core import conductor as cmod
from hive.core.visibility import Viewer
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, dump, script, wait
from hive.tests.test_ask_conversation import _ago, _context, _taiga
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

WORDS = ("the board is a row of sliders: make it a 3 by 3 grid that switches between X and O and says who won, and "
         "think as long as you need")
SAID = "Making the board a 3 by 3 grid now."
STOP = cmod.LIMIT_SAY["time_cap"]
SECTION = "What they asked you to continue"


def _home(w):
    return {"swarm_id": w["swarm"]["id"]}


def _stopped(client, w, op, text=WORDS, said=SAID, **extra):
    """A conducted turn that stops at its time limit, as Haley's did: it says what it is doing, then waits on an act
    the page never answers until its time runs out (the time cap mid-await, so no paid call is cut off). Returns the
    admission's body and the script that answered it."""
    conductor = w["hive"].ask.conductor
    before, conductor.turn_seconds = conductor.turn_seconds, 0.6
    try:
        s = script(client, Script([call("say", text=said), call("navigate", route="#/artifacts", label="Artifacts")],
                                  "never"))
        r = ask(client, w["ann"], op, text=text, **extra)
        assert r.status_code == 202, r.text
        fs = wait(w["hive"], op, closed)
    finally:
        conductor.turn_seconds = before
    assert fs[-1]["outcome"] == "time_cap"
    return r.json(), s


def _section(s):
    context = _context(s.bodies[0])
    return context[context.index(SECTION):]


def test_a_continue_in_a_swarms_thread_reads_the_request_that_stopped(client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    w = _taiga(client, monkeypatch)
    stopped, _ = _stopped(client, w, "op-cont-swarm-01", context=_home(w))
    assert stopped["thread"]["mind"]["id"] == w["coord"]["id"]   # routed to the swarm's coordinator, as Haley's was
    # her browser kept the stopped exchange under the mind that spoke, her own (store/ask.ts keepStopped)
    kept = {"said": WORDS, "answer": f"{SAID}\n{STOP}", "by": w["mine"]["id"], "at": _ago(0.2)}
    s = script(client, Script("Carrying on with the grid: it switches turns now."))
    r = ask(client, w["ann"], "op-cont-swarm-02", text="Continue", context=_home(w), continues=stopped["turn_id"],
            conversation=[kept])
    assert r.status_code == 202, r.text
    wait(w["hive"], "op-cont-swarm-02", closed)
    section = _section(s)
    assert f"- just now, they said: “{WORDS}”" in section
    assert f"- the answer when it stopped, just now: “{SAID} {STOP}”" in section
    # the browser's copy, kept under her own mind, still never reaches a swarm turn (Jon on #346)
    context = _context(s.bodies[0])
    assert "The conversation so far in the Ask" not in context
    assert s.bodies[0]["messages"][2] == {"role": "user", "content": "Continue"}
    # the log names the turn continued, never its words
    assert f"is told what it continues from {stopped['turn_id']}" in caplog.text and WORDS not in caplog.text


def test_a_continue_of_a_continue_reads_the_first_request_and_where_it_last_stopped(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    first, _ = _stopped(client, w, "op-cont-chain-01", context=_home(w))
    second, s2 = _stopped(client, w, "op-cont-chain-02", text="Continue", said="The grid is in; now the win check.",
                          context=_home(w), continues=first["turn_id"])
    # the Continue on the way was told the first request and its answer
    assert f"they said: “{WORDS}”" in _section(s2) and SAID in _section(s2)
    s = script(client, Script("Done: it names the winner."))
    ask(client, w["ann"], "op-cont-chain-03", text="Continue", context=_home(w), continues=second["turn_id"])
    wait(w["hive"], "op-cont-chain-03", closed)
    section = _section(s)
    assert f"they said: “{WORDS}”" in section
    assert "- they asked you to continue it once before this" in section
    # the latest answer carries on the earlier ones, which that turn was told
    assert f"the answer when it stopped, just now: “The grid is in; now the win check. {STOP}”" in section
    assert SAID not in section


def test_a_continue_with_her_own_mind_gets_no_words_from_the_host_which_kept_none(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    stopped, _ = _stopped(client, w, "op-cont-own-01")
    assert stopped["acting_as"]["name"] == "Taiga"   # her own mind's turn: its words stay in her browser
    kept = {"said": WORDS, "answer": f"{SAID}\n{STOP}", "by": w["mine"]["id"], "at": _ago(0.2)}
    s = script(client, Script("Carrying on with the grid."))
    ask(client, w["ann"], "op-cont-own-02", text="Continue", continues=stopped["turn_id"], conversation=[kept])
    wait(w["hive"], "op-cont-own-02", closed)
    section = _section(s)
    assert "their words and each answer then stay in their own browser" in section
    assert WORDS not in section and SAID not in section
    # her browser's copy carries them, as every exchange reaches her own mind's turn
    context = _context(s.bodies[0])
    assert f"they said: “{WORDS}”" in context[context.index("The conversation so far in the Ask"):]
    assert WORDS not in dump(w["hive"]) and SAID not in dump(w["hive"])


def test_a_turn_whose_thread_she_deleted_gives_none_of_its_words_back(client, monkeypatch):
    w = _taiga(client, monkeypatch)
    hive, ann = w["hive"], Viewer("user:u_ann", False)
    first, _ = _stopped(client, w, "op-cont-gone-01", context=_home(w))
    hive.sessions.end(ann, first["thread"]["id"])   # the Continue then opens a thread of its own
    second, _ = _stopped(client, w, "op-cont-gone-02", text="Continue", said="The grid is in.", context=_home(w),
                         continues=first["turn_id"])
    assert second["thread"]["id"] != first["thread"]["id"]
    assert client.delete(f"/api/ask/threads/{first['thread']['id']}", headers=w["ann"]).status_code == 200
    s = script(client, Script("Carrying on."))
    r = ask(client, w["ann"], "op-cont-gone-03", text="Continue", context=_home(w), continues=second["turn_id"])
    assert r.status_code == 202, r.text
    wait(hive, "op-cont-gone-03", closed)
    section = _section(s)
    assert WORDS not in section and SAID not in section
    assert "- they asked you to continue it once before this" in section
    assert f"the answer when it stopped, just now: “The grid is in. {STOP}”" in section
