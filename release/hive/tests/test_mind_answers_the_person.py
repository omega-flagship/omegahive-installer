# Purpose: tests that a mind answers a person who wrote to it, or the person is told it stopped: each time the mind
# rests (its turns spent or a wait chosen) while it owes an answer, the hive reminds it once with new turns, then leaves a
# note in the person's chat; a queued answer counts, hive-goals lists owed answers, and the hive's own notes, Ask turns,
# rooms and answered messages owe nothing.
"""A mind answers the person who wrote to it, or the person learns it stopped (testers' v0.28 and v0.29 gates, 13 Nov).

Asked in its own chat to start a code mind, a tester's mind explored the code-mind skills, read an empty task list,
pinned "stop code-mind exploration (no task needs it) -> wait for Ahmad's reply" and rested. Asked to make and publish
a flow, another failed four times, pinned "idle: no assigned task seen" and rested. On v0.29 a third, asked for the
same flow, spent the ten turns its message bought and stopped calling its model with no wait at all. None of the
people was told anything.

Invented lives: Rosa writes to her mind; every message here is made up.
"""
import asyncio
import json
import pathlib

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_mind_files import bridge

ROOT = pathlib.Path(__file__).resolve().parents[2]
CODE_MIND = "Start a code mind that writes a one-line Python script printing hello, and tell me once it has started."
FLOW = "Make a flow called gate-hello that just says hello to me, then publish it so I can run it."


def _mind(client):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    return client.app.state.hive, mind


def _rest(client, mind, in_flight=()):
    return client.post("/api/agent/replies/rest", headers=agent_headers(mind), json={"in_flight": list(in_flight)}).json()


def _tell(client, mind, text):
    return client.post(f"/api/agents/{mind['id']}/messages", json={"text": text}).json()


def _answer(hive, mind, conversation_id, text):
    hive.record_agent_message(mind["id"], {"text": text, "conversation_id": conversation_id})


def _from_hive(hive, mind, sender):
    return hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND sender = ? ORDER BY rowid", (mind["id"], sender))


def _shown(client, mind, message_id):
    return [m for m in client.get(f"/api/agents/{mind['id']}/messages").json() if m["id"] == message_id]


def test_a_mind_that_rests_owing_an_answer_is_reminded_and_gets_new_turns(client):
    hive, mind = _mind(client)
    assert _rest(client, mind) == {"sent": None}                     # nothing owed yet
    asked = _tell(client, mind, CODE_MIND)
    assert _rest(client, mind)["sent"] == "reminder"
    [reminder] = _from_hive(hive, mind, "hive:reply-reminder")
    # it reaches the mind as a new message in that chat, which the loop answers with fresh turns
    assert reminder["direction"] == "in" and reminder["conversation_id"] == asked["conversation_id"]
    assert reminder["text"].startswith("HIVE-REPLY-OWED ")
    assert "Start a code mind that writes a one-line Python script printing hello" in reminder["text"]
    assert f"send-hive-to {asked['conversation_id']} " in reminder["text"]
    shown = _shown(client, mind, reminder["id"])
    assert not shown or shown[0].get("mind_only")                    # people never read the hive's reminder
    _answer(hive, mind, asked["conversation_id"], "I can't start a code mind myself; I've asked Create to start one.")
    assert _rest(client, mind) == {"sent": None}
    assert client.get("/api/agent/replies/owed", headers=agent_headers(mind)).json() == {"owed": []}


def test_the_reminder_names_what_the_mind_saved_since_the_message_so_it_answers_instead_of_saving_again(client):
    # A v0.36 update check: asked to save a plan, a mind saved it, sent nothing and rested; reminded with only the
    # person's words, it saved the plan a second time before it answered.
    import time
    hive, mind = _mind(client)
    old = client.post("/api/agent/artifacts", headers=agent_headers(mind), json={"kind": "plan", "title": "Last week's plan"}).json()
    hive.db.execute("UPDATE artifacts SET created_at = ? WHERE id = ?", ("2026-01-01T00:00:00.000Z", old["id"]))
    asked = _tell(client, mind, "Please make me a short plan for a family weekend in Lisbon and save it in the hive.")
    time.sleep(0.01)                       # the hive's clock counts milliseconds; the mind saves after the message
    plan = client.post("/api/agent/artifacts", headers=agent_headers(mind),
                       json={"kind": "plan", "title": "Family weekend in Lisbon"}).json()
    client.post(f"/api/agent/artifacts/{plan['id']}/revisions", headers=agent_headers(mind),
                json={"body": "Saturday: the aquarium. Sunday: the castle.", "parent": None}).raise_for_status()
    assert _rest(client, mind)["sent"] == "reminder"
    [reminder] = _from_hive(hive, mind, "hive:reply-reminder")
    assert reminder["conversation_id"] == asked["conversation_id"]
    assert (f'Since they asked, you saved "Family weekend in Lisbon" ({plan["id"]}, plan, revision 1); if that is what '
            "they asked for, tell them so instead of making it again.") in reminder["text"]
    assert "Last week's plan" not in reminder["text"]
    assert hive.replies.saved_since(mind["id"], "2026-01-01T00:00:00.000Z")[1]["id"] == old["id"]   # newest first


def test_a_reminder_after_nothing_was_saved_names_nothing(client):
    hive, mind = _mind(client)
    _tell(client, mind, CODE_MIND)
    assert _rest(client, mind)["sent"] == "reminder"
    [reminder] = _from_hive(hive, mind, "hive:reply-reminder")
    assert "Since they asked" not in reminder["text"] and "Answer them before you rest" in reminder["text"]


def test_if_it_rests_again_the_hive_tells_the_person_in_their_chat_once(client):
    hive, mind = _mind(client)
    asked = _tell(client, mind, FLOW)
    assert _rest(client, mind)["sent"] == "reminder"                 # its turns ran out, or it waited: reminded
    assert _rest(client, mind)["sent"] == "note"                     # again: the hive leaves its note
    assert _rest(client, mind) == {"sent": None}                     # once
    [note] = _from_hive(hive, mind, "hive:reply-owed")
    assert note["conversation_id"] == asked["conversation_id"] and note["direction"] == "in"   # the mind reads it too
    assert note["text"].startswith(f'{mind["name"]} stopped without answering "Make a flow called gate-hello')
    shown = _shown(client, mind, note["id"])
    assert shown and not shown[0].get("mind_only")                   # people read it in their chat


def test_an_answer_still_queued_owes_nothing_at_that_rest(client):
    hive, mind = _mind(client)
    asked = _tell(client, mind, "Is the bakery open on Sunday?")
    # the mind answered and rested in one response: its channel had not sent the answer when the loop asked
    assert _rest(client, mind, [asked["conversation_id"]]) == {"sent": None}
    assert _from_hive(hive, mind, "hive:reply-reminder") == []
    assert _rest(client, mind)["sent"] == "reminder"                 # with nothing queued it is owed again


def test_hive_goals_lists_what_the_mind_still_owes_an_answer(client, monkeypatch, tmp_path):
    hive, mind = _mind(client)
    asked = _tell(client, mind, "What's on my calendar tomorrow?")
    hc, _ = bridge(client, monkeypatch, mind, tmp_path)
    monkeypatch.setenv("HIVE_AGENT_ID", mind["id"])
    # only the owed-answers block is checked: other blocks (a done list, say) may come before or after it
    out = hc.goals()
    assert out.startswith("HIVE-GOALS yours: none || open: none || ")
    assert f' || owed answers: the person: "What\'s on my calendar tomorrow?" (send-hive-to {asked["conversation_id"]} <answer>)' in out
    _answer(hive, mind, asked["conversation_id"], "Nothing tomorrow.")
    answered = hc.goals()
    assert answered.startswith("HIVE-GOALS yours: none || open: none") and "owed answers" not in answered


def test_the_mind_reports_each_rest_with_its_queued_answers_and_just_rests_when_the_hive_is_lost(client, monkeypatch,
                                                                                                 tmp_path):
    hive, mind = _mind(client)
    asked = _tell(client, mind, "Please summarise yesterday's notes.")
    hc, calls = bridge(client, monkeypatch, mind, tmp_path)
    monkeypatch.syspath_prepend(str(ROOT / "modules" / "channel_hive" / "src"))
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    channel = tmp_path / "hive"
    channel.mkdir()
    sent = json.dumps({"type": "agent_message", "text": "an older answer", "conversation_id": "c_sent_already"}) + "\n"
    queued = json.dumps({"type": "agent_message", "text": "Here is the summary.", "conversation_id": asked["conversation_id"]})
    (channel / "outbox.jsonl").write_text(sent + queued + "\n" + '{"type": "agent_mess')   # the daemon sent only the first
    (channel / "outbox.offset").write_text(str(len(sent.encode())))
    assert hc.authorize('(wait "900 no tasks, nothing waiting on me")') is True   # a wait is the mind's own call again
    assert ("POST", "/api/agent/authorize") not in calls
    assert hc.rest_check() == "HIVE-REST-CHECKED" and ("POST", "/api/agent/replies/rest") in calls
    assert _from_hive(hive, mind, "hive:reply-reminder") == []       # the queued answer counted
    (channel / "outbox.offset").write_text(str(len((sent + queued + "\n").encode())))   # sent, but never reached the hive
    hc.rest_check()
    assert len(_from_hive(hive, mind, "hive:reply-reminder")) == 1

    def unreachable(*args, **kwargs):
        raise OSError("the hive is not answering")
    monkeypatch.setattr(hc.urllib.request, "urlopen", unreachable)
    assert hc.rest_check() == "HIVE-REST-CHECKED"                    # a mind can always rest when the hive can't be asked


def test_the_loop_reports_rests_but_not_the_runtimes_short_retries():
    hooks = (ROOT / "hive" / "runtime" / "extensions" / "loop_hooks.metta").read_text()
    end = hooks.split("(= (hive-cycle-end)", 1)[1].split("\n\n", 1)[0]
    assert "(hive-rest-check)" in end
    check = hooks.split("(= (hive-rest-check)", 1)[1].split("\n\n", 1)[0]
    assert "(<= (get-state &loops) 0)" in check and "(py-call (hive_commons.rest_check))" in check
    complete = hooks.split("(= (hive-complete $msg $msgnew)", 1)[1].split("\n\n", 1)[0]
    # a retry whose next turn comes by itself is no rest, and a format failure past its retries is one
    # (hive_helpers.runtime_retry_due, tested without a runtime in tests/test_wait_quiet_runtime.py)
    assert "(hive_helpers.runtime_retry_due $kind (get-state &formatRetries))" in complete
    assert complete.index("(honor-chosen-wait $sexpr") < complete.index("&restCheckDue")


def test_the_hives_own_notes_ask_turns_rooms_and_answered_messages_owe_nothing(client):
    hive, mind = _mind(client)
    asyncio.run(hive.send_to_agent(mind["id"], "[FILE-ADDED 1a2b3c] Rosa added notes.txt", sender="hive:files"))
    hive.enqueue_message(mind["id"], "an Ask turn", "ask:t_invented", "user:operator")   # Ask answers through its turn
    hive.enqueue_message(mind["id"], "@Dot0 hello room", "r_invented_room", "user:operator")
    assert _rest(client, mind) == {"sent": None}
    asked = _tell(client, mind, "thanks!")
    _answer(hive, mind, asked["conversation_id"], "You're welcome.")
    assert _rest(client, mind) == {"sent": None}


def test_each_person_is_owed_in_their_own_chat_newest_first(client):
    hive, mind = _mind(client)
    rosa = f"c_{mind['id']}~user:rosa"
    hive.enqueue_message(mind["id"], "Can you read my PDF?", rosa, "user:rosa")
    operator = _tell(client, mind, "And book the bakery van for Friday.")
    owed = client.get("/api/agent/replies/owed", headers=agent_headers(mind)).json()["owed"]
    assert [(o["conversation_id"], o["from_name"]) for o in owed] == [(operator["conversation_id"], "the person"),
                                                                        (rosa, "Rosa")]
    _answer(hive, mind, operator["conversation_id"], "Booked.")
    assert _rest(client, mind)["sent"] == "reminder"
    [reminder] = _from_hive(hive, mind, "hive:reply-reminder")
    assert reminder["conversation_id"] == rosa and f"send-hive-to {rosa} " in reminder["text"]
    assert "Rosa asked you" in reminder["text"]
