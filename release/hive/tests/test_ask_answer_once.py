"""Purpose: an Ask answer a mind gives with `say` is shown once, because nothing asks the mind for a closing reply.

Invented lives only: Ann (user:u_ann, the test world's person) and her own mind. CAVEAT is what a real model said with
`say` on 16 Nov (claude-sonnet-5.5). Asked for a closing reply after it, that model wrote the answer again ("I have it:
HEMLOCK-SEVEN.") in 5 of 5 replays, so the loop no longer asks (Jon on #358):
- a say marked done ends the turn after its step: no further model call, and its words are the whole answer, once;
- a mind that ends without done ends on an empty reply, which adds nothing;
- a mind that never said anything answers with its reply;
- a call of the done step that came back not ok lets the mind go on, to say what happened;
- a closing reply the mind does write is shown as written: only mind-voice r1's exact repeat is taken out.
"""
import time

from hive.core import conductor as cmod
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, script, tool_results, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_ask import _on

CAVEAT = ("Got it: your code word is HEMLOCK-SEVEN. One caveat: I only remember what comes back from your browser's notes "
          "and our earlier threads. I can't save anything new myself, so if it matters, add it to your notes.")


def _turn(client, monkeypatch, op, *steps, text="Please remember my code word for later: HEMLOCK-SEVEN."):
    """One Ask turn of Ann's own mind against a scripted model. Its frames are read as published, since a personal
    turn's stored frames keep no words."""
    w = _on(client, monkeypatch)
    hive = w["hive"]
    s = script(client, Script(*steps))
    published, publish = [], hive.ask._publish
    monkeypatch.setattr(hive.ask, "_publish", lambda fs: (published.extend(f for f in fs if f), publish(fs))[1])
    r = ask(client, w["ann"], op, text=text)
    assert r.status_code == 202, r.text
    return w, s, published, r.json()["turn_id"]


def _mine(published, turn_id, phase):
    return [f for f in published if f.get("turn_id") == turn_id and f.get("phase") == phase]


def _said_and_whole(published, turn_id):
    answers = _mine(published, turn_id, "answer")
    return [f["text"] for f in answers if f.get("delta")], [f["text"] for f in answers if not f.get("delta")]


def _act(published, turn_id, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        found = _mine(published, turn_id, "act")
        if found:
            return found[0]["act"]
        time.sleep(0.02)
    raise AssertionError("no act frame")


def _join(said, closing):
    st = cmod.TurnState("t", "user:u_x", "op", "m", 1.0, False)
    st.said = list(said)
    return cmod.Conductor.__new__(cmod.Conductor)._answer_text(st, closing)


def test_a_done_say_ends_the_turn_with_no_further_model_call_and_its_words_once(client, monkeypatch):
    w, s, published, turn_id = _turn(client, monkeypatch, "op-once-done-01", [call("say", text=CAVEAT, done=True)])
    wait(w["hive"], "op-once-done-01", closed)
    assert len(s.bodies) == 1                    # nothing asked the mind for a closing reply after its last words
    assert _said_and_whole(published, turn_id) == ([CAVEAT], [CAVEAT])
    say = next(t for t in s.bodies[0]["tools"] if t["function"]["name"] == "say")["function"]["parameters"]
    assert say["properties"]["done"]["type"] == "boolean" and say["required"] == ["text"]   # offered, never required
    assert [f["outcome"] for f in _mine(published, turn_id, "done")] == ["complete"]


def test_an_empty_reply_after_say_ends_the_turn_and_adds_nothing(client, monkeypatch):
    w, s, published, turn_id = _turn(client, monkeypatch, "op-once-empty-01", [call("say", text=CAVEAT)], "")
    wait(w["hive"], "op-once-empty-01", closed)
    assert len(s.bodies) == 2
    assert _said_and_whole(published, turn_id) == ([CAVEAT], [CAVEAT])
    assert [f["outcome"] for f in _mine(published, turn_id, "done")] == ["complete"]


def test_a_mind_that_said_nothing_answers_with_its_reply(client, monkeypatch):
    reply = "Your code word is HEMLOCK-SEVEN, and I have it."
    w, s, published, turn_id = _turn(client, monkeypatch, "op-once-reply-01", reply)
    wait(w["hive"], "op-once-reply-01", closed)
    assert len(s.bodies) == 1
    assert _said_and_whole(published, turn_id) == ([], [reply])


def test_a_done_say_beside_an_act_ends_the_turn_once_the_act_has_worked(client, monkeypatch):
    w, s, published, turn_id = _turn(client, monkeypatch, "op-once-act-01",
                                     [call("navigate", route="#/goals", label="Goals"), call("say", text="Here are your goals.", done=True)],
                                     text="show me my goals")
    act = _act(published, turn_id)
    r = client.post(f"/api/ask/op-once-act-01/acts/{act['act_id']}/result", headers=w["ann"], json={"ok": True, "route": "#/goals"})
    assert r.status_code == 200, r.text
    wait(w["hive"], "op-once-act-01", closed)
    assert len(s.bodies) == 1
    assert _said_and_whole(published, turn_id)[1] == ["Here are your goals."]


def test_a_failed_act_beside_a_done_say_lets_the_mind_go_on_and_say_so(client, monkeypatch):
    w, s, published, turn_id = _turn(client, monkeypatch, "op-once-act-02",
                                     [call("navigate", route="#/goals", label="Goals"), call("say", text="Opening your goals.", done=True)],
                                     [call("say", text="I couldn't open Goals from here.", done=True)],
                                     text="show me my goals")
    act = _act(published, turn_id)
    r = client.post(f"/api/ask/op-once-act-02/acts/{act['act_id']}/result", headers=w["ann"],
                    json={"ok": False, "reason": "unknown_target"})
    assert r.status_code == 200, r.text
    wait(w["hive"], "op-once-act-02", closed)
    assert len(s.bodies) == 2                    # the failed act voided done: the mind heard it and went on
    heard = tool_results(s.bodies[1])
    assert heard[0]["act_id"] == act["act_id"] and heard[0]["ok"] is False and heard[0]["reason"] == "unknown_target"
    assert _said_and_whole(published, turn_id)[1] == ["Opening your goals.\n\nI couldn't open Goals from here."]


def test_a_closing_reply_the_mind_writes_is_shown_as_written():
    """No word list judges a closing any more: a restatement, a correction and a qualifier are all the mind's own words.
    Only mind-voice r1's exact repeat goes, as before."""
    said = "Your code word is HEMLOCK-SEVEN and I keep it."
    for closing in ("I have it: HEMLOCK-SEVEN.", "Actually, your code word is not HEMLOCK-SEVEN.",
                    "Your code word is HEMLOCK-SEVEN, but I keep it."):
        assert _join([said], closing) == said + "\n\n" + closing, closing
    assert _join([CAVEAT], CAVEAT) == CAVEAT
    assert _join([], "First line.\n\nSecond line.") == "First line.\n\nSecond line."
