"""mind-voice r1 (Jon 11-03, "personal mind, not the Ask"): a thread with a mind is answered by that mind.

Invented lives only: Ann (user:u_ann, the test world's person) and her personal mind, renamed Juniper here with an
invented persona. In thread A they talk about a travel app; in a new thread B she asks "what about that travel app?".
- the answer's system prompt is Juniper's own (name and persona), never "the Ask conductor";
- her browser's memory of thread A (a `mind_` note) reaches thread B's model, with HIVE_ASK_MEMORY unset;
- a reply said with `say` and repeated as the closing text is answered once;
- a mind-thread note never reaches another mind's turn, and no note reaches a non-personal turn with memory off;
- the accepted frame says whose model answers: her own mind's on a turn with it, the Ask's on a swarm turn in her voice.
"""
import json

from hive.core import conductor as cmod
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_ask import _on

PERSONA = "Juniper is warm and practical, and loves maps and trail food."
THREAD_A_WORDS = "Let's design a travel app for long-distance hikers: offline maps and resupply stops."
THREAD_A_ANSWER = "Juniper here. A hikers' travel app: offline trail maps first, then resupply stops along the route."


def _juniper(client, monkeypatch):
    w = _on(client, monkeypatch)
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    w["hive"].db.execute("UPDATE agents SET name = 'Juniper', persona = ? WHERE id = ?", (PERSONA, w["mine"]["id"]))
    return w


def _system(body):
    return body["messages"][0]["content"][0]["text"]


def _answers(fs):
    return [f for f in fs if f["phase"] == "answer" and not f.get("delta")]


def test_a_personal_thread_is_answered_in_the_minds_voice_with_its_memory_of_an_earlier_thread_once(client, monkeypatch):
    w = _juniper(client, monkeypatch)
    hive = w["hive"]
    # thread A: the travel app is discussed
    s = script(client, Script(THREAD_A_ANSWER))
    a = ask(client, w["ann"], "op-mv-thread-a", text=THREAD_A_WORDS)
    assert a.status_code == 202 and a.json()["acting_as"]["name"] == "Juniper"
    wait(hive, "op-mv-thread-a", closed)
    system = _system(s.bodies[0])
    assert "You are Juniper" in system and PERSONA in system and "personal mind" in system
    assert "Ask conductor" not in system and "conductor of OmegaHive" not in system
    # New thread: thread B starts empty on the host (a personal turn stores no words); the browser kept thread A
    client.post(f"/api/sessions/{a.json()['thread']['id']}/end", headers=w["ann"])
    kept = {"id": "mind_" + a.json()["turn_id"],
            "text": f"earlier thread with you: they asked “{THREAD_A_WORDS}”; you answered “{THREAD_A_ANSWER}”"}
    reply = "Juniper here: the hikers' travel app from before. Next I'd sketch the offline trail maps screen."
    s = script(client, Script([call("say", text=reply)], reply))   # said, then repeated as the closing text
    published, publish = [], hive.ask._publish
    monkeypatch.setattr(hive.ask, "_publish", lambda fs: (published.extend(f for f in fs if f), publish(fs))[1])
    b = ask(client, w["ann"], "op-mv-thread-b", text="what about that travel app?", memory_notes=[kept])
    assert b.status_code == 202 and b.json()["thread"]["id"] != a.json()["thread"]["id"]
    fs = wait(hive, "op-mv-thread-b", closed)
    # the page says where the answer came from: her own mind's model alone, since this turn is with her mind
    assert [f.get("conducted") for f in fs if f["phase"] == "accepted"] == ["mind"]
    system, context = _system(s.bodies[0]), s.bodies[0]["messages"][1]["content"]
    assert "You are Juniper" in system and "Ask conductor" not in system
    assert "travel app for long-distance hikers" in context and "earlier thread with you" in context
    # the reply renders exactly once: one whole answer, its words not doubled (the live frame carries the words; the
    # stored frames of a personal turn are content-free)
    assert client.get("/api/ask/op-mv-thread-b", headers=w["ann"]).json()["state"] == "done"
    assert len(_answers(fs)) == 1
    whole = [f["text"] for f in published if f.get("turn_id") == b.json()["turn_id"] and f["phase"] == "answer" and not f.get("delta")]
    assert whole == [reply]
    assert "Ask conductor" not in json.dumps(published)

def test_the_answer_text_keeps_repeated_words_once():
    st = cmod.TurnState("t", "user:u_x", "op", "m", 1.0, False)
    c = cmod.Conductor.__new__(cmod.Conductor)
    whole = "The hikers' travel app: offline trail maps first, then resupply stops."
    st.said = [whole]
    assert c._answer_text(st, whole) == whole                                   # said, then the same closing text
    assert c._answer_text(st, "  " + whole.upper() + " ") == whole              # spacing and case do not make it new
    st.said = ["Let me open your goals page now.", "Three goals are open."]
    assert c._answer_text(st, "Let me open your goals page now.\n\nThree goals are open.") == \
        "Let me open your goals page now.\n\nThree goals are open."              # the whole joined text, once
    st.said = ["Looking at your goals page now."]
    assert c._answer_text(st, "Looking at your goals page now. Three are open, one is late.") == \
        "Looking at your goals page now. Three are open, one is late."          # restated and extended: the closing text
    st.said = ["Looking now."]
    assert c._answer_text(st, "ok") == "Looking now.\n\nok"                    # a short word inside another is no repeat
    st.said = []
    assert c._answer_text(st, "Done here.") == "Done here."


def test_mind_thread_notes_reach_only_the_persons_own_mind_and_other_notes_only_with_memory_on():
    notes = [{"id": "mind_at_1", "text": "earlier thread with you: a travel app"}, "prefers dark looks"]
    assert cmod.turn_notes(notes, True, False) == notes                        # personal: memory on or off
    assert cmod.turn_notes(notes, False, False) is None                         # any other turn, memory off: none
    assert cmod.turn_notes(notes, False, True) == ["prefers dark looks"]       # memory on: never a mind-thread note
    assert cmod.turn_notes([notes[0]], False, True) is None
    assert cmod.turn_notes(None, True, True) is None


def test_a_swarm_turn_speaks_as_the_persons_own_mind_and_never_reads_a_mind_thread_note(client, monkeypatch):
    """Jon 11-09, "Your model IS your Ask": a turn routed to a swarm (the floating box on a swarm's page) is answered by
    the person's own mind, working through that swarm's coordinator; money, limits and thread stay the coordinator's.
    A mind-thread note stays off it: its words are stored in the swarm's room, unlike a personal turn's."""
    w = _juniper(client, monkeypatch)
    hive = w["hive"]
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (w["coord"]["id"],))
    s = script(client, Script("ok"))
    note = {"id": "mind_at_2", "text": "earlier thread with you: MINDONLYCANARY travel app"}
    r = ask(client, w["ann"], "op-mv-coord-01", context={"swarm_id": w["swarm"]["id"]}, memory_notes=[note, "likes short answers"])
    assert r.status_code == 202 and r.json()["acting_as"] is None and r.json()["thread"]["mind"]["id"] == w["coord"]["id"]
    # the page names the voice that answers (speaks_as): her own mind, though the thread and its money are the coordinator's
    assert r.json()["speaks_as"] == {"mind_id": w["mine"]["id"], "name": "Juniper"}
    fs = wait(hive, "op-mv-coord-01", closed)
    assert s.bodies, [(f["phase"], f.get("outcome")) for f in fs]
    # the voice is hers, but the model is the one the Ask uses, so the page doesn't call it her mind's model
    assert [f.get("conducted") for f in fs if f["phase"] == "accepted"] == ["ask"]
    system, context = _system(s.bodies[0]), s.bodies[0]["messages"][1]["content"]
    assert "You are Juniper" in system and PERSONA in system and "Ask conductor" not in system
    assert f"working in the swarm {w['swarm']['name']}" in system and f"You are {w['coord']['name']}" not in system
    assert "MINDONLYCANARY" not in json.dumps(s.bodies) and "likes short answers" in context
    assert {u["agent_id"] for u in hive.db.all("SELECT agent_id FROM usage")} == {w["coord"]["id"]}   # money as before


def test_a_mind_is_never_named_after_its_person_and_speaks_unnamed_until_named(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    person = hive.personal.person("user:u_ann")
    old = hive.personal.display_name(person)
    # a mind made before the ruling carries its person's name: the next sign-in (ensure) gives it the default name
    hive.db.execute("UPDATE agents SET name = ? WHERE id = ?", (old, w["mine"]["id"]))
    assert hive.personal.ensure("user:u_ann")["name"] == "Your mind"
    system = cmod.mind_system(hive.personal.mind_row("user:u_ann"), True)
    assert "own mind" in system and "not given you a name yet" in system and old not in system and "Your mind" not in system
    # a name the person gives it is kept
    assert client.post("/api/me/mind", json={"name": "Taiga"}, headers=w["ann"]).json()["mind"]["name"] == "Taiga"
    assert hive.personal.ensure("user:u_ann")["name"] == "Taiga"
    assert "You are Taiga" in cmod.mind_system(hive.personal.mind_row("user:u_ann"), True)


def test_capabilities_say_a_personal_turn_reads_memory_whatever_the_memory_switch(client, monkeypatch):
    w = _juniper(client, monkeypatch)
    caps = client.get("/api/me/ask", headers=w["ann"]).json()["capabilities"]
    assert caps["conductor"] is True and caps["memory"] is False and caps["mind_memory"] is True


def test_the_persons_mind_answers_wherever_it_runs_browser_iter_when_on_hive_run_when_off(client, monkeypatch):
    """Jon 11-09: the person's mind (their Ask) is their own Iter in their browser worker when the personal-mind gateway
    is on and their preference is on; otherwise the hive runs it. The same mind either way, never the conductor's own
    voice. The stack stays off in production; this switches it on in this test's process only."""
    w = _juniper(client, monkeypatch)
    hive = w["hive"]
    # browser path: gateway on (preference on by default), the page marks the turn answer_in=browser
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    s = script(client, Script("the conductor must not speak"))
    r = ask(client, w["ann"], "op-mv-iter-01", text="what about that travel app?", answer_in="browser")
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["route"] == "browser_mind" and body["state"] == "browser"                # the browser Iter route
    assert body["thread"]["mind"]["id"] == w["mine"]["id"] and body["acting_as"]["name"] == "Juniper"
    assert s.bodies == []                                                                 # nothing ran hive-side
    client.post(f"/api/ask/op-mv-iter-01/done", headers={**w["ann"], "Origin": "http://127.0.0.1:8700"}, json={"outcome": "complete"})
    client.post(f"/api/sessions/{body['thread']['id']}/end", headers=w["ann"])
    # hive-run path: the gateway off (testers' hives today): the same mind answers through the hive's loop, in its voice
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    s = script(client, Script("Juniper here: the hikers' travel app."))
    r = ask(client, w["ann"], "op-mv-hive-01", text="what about that travel app?")
    assert r.status_code == 202 and r.json().get("route") != "browser_mind" and r.json()["acting_as"]["name"] == "Juniper"
    wait(hive, "op-mv-hive-01", closed)
    assert len(s.bodies) == 1 and "You are Juniper" in _system(s.bodies[0]) and "Ask conductor" not in _system(s.bodies[0])


def test_the_chat_says_it_cannot_open_files_and_offers_files_and_storage_or_the_minds_own_chat(client, monkeypatch):
    """Lisbon testers, 10 Nov: one shared a folder with her mind in the Ask and got answers that could not see it. No
    chat tool reads a file; a mind in its own chat reads what its rules allow (mind_files.py). Every turn's model is
    told so, with the two routes that work."""
    w = _juniper(client, monkeypatch)
    hive = w["hive"]
    mine = hive.personal.mind_row("user:u_ann")
    s = script(client, Script("I can't open files from this chat."))
    r = ask(client, w["ann"], "op-mv-files-01", text="I put my trip notes in a folder. Can you read them?")
    assert r.status_code == 202
    wait(hive, "op-mv-files-01", closed)
    system = _system(s.bodies[0])
    assert "cannot open a file or a folder in this chat" in system and "never answer as if you had read it" in system
    assert "Files and storage ('#/assets')" in system and f"your own chat ('#/dot/{mine['id']}')" in system
    assert "the files they can see and your swarm's linked folders" in system
    # a swarm's mind answering in its own name offers its own chat and what its swarm was given
    other = cmod.mind_system(w["coord"], False, swarm_name=w["swarm"]["name"])
    assert f"your own chat ('#/dot/{w['coord']['id']}')" in other and "the files given to your swarm and its linked folders" in other
    # the size estimate made before a mind is known carries the rule too
    assert "cannot open a file or a folder in this chat" in cmod.SYSTEM and "#/dot/" not in cmod.SYSTEM
