"""Purpose: the Ask and a mind's own chat are one conversation (Jon, 16 Nov: "context and continuity are consistently
persistent regardless of which model you interact", "without needing additional LLM calls to pass through convo").

Invented lives only: Ann (user:u_ann) and her own mind, renamed Taiga here; Bob (user:u_bob) and his own mind; the
test world's swarm Home with its coordinator Orchestra and a mind called Worker.
- a message in her own chat with a mind may carry the Ask exchanges that mind has not heard (from_ask); the mind's
  envelope holds them as lines naming who answered, both channel kinds show them before her words, and her own view of
  the chat shows only her words;
- from_ask is taken only in her own chat with the mind, in the conversation's shape; a mind that isn't her own (Bob's
  own mind, a swarm's) is told only the exchanges it answered itself, whatever her page sends;
- a stamp in her chat that doesn't read costs that line its age, never the Ask turn;
- an Ask turn reads her own chat with the mind that answers, and nothing else of the mind's messages;
- a turn kept in a swarm's thread reads that chat only for one of the swarm's own minds (Jon on #347): a swarm turn
  speaking as Taiga reads nothing of her chat with Taiga, and Taiga is told it stays private unless she says it there.
"""
import json
import time

from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, closed, script, wait
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_chat_identity import _load
from hive.tests.test_personal_mind_ask import _on

CODE = "my code word is HEMLOCK-SEVEN"


def _world(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    hive.db.execute("UPDATE agents SET name = 'Taiga' WHERE id = ?", (w["mine"]["id"],))
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (w["worker"]["id"],))
    # the coordinator answers on the host's priced key (_on): a $5 cap of its own, so a swarm turn reaches the model
    hive.db.execute("UPDATE agents SET budget_usd = 5 WHERE id = ?", (w["coord"]["id"],))
    return w


def _at(minutes_ago):
    return time.time() * 1000 - minutes_ago * 60_000


def _inbox(client, mind):
    out = client.get("/api/agent/inbox", headers=agent_headers(mind), params={"after": 0}).json()["messages"]
    return [json.loads(m["text"]) for m in out]


def _told(hive, mind):
    """What the newest message to this mind tells it of the Ask (its envelope's ask_earlier), read from the store: a
    person's own mind has no token a test can hold."""
    row = hive.db.one("SELECT extra FROM messages WHERE agent_id = ? AND direction = 'in' ORDER BY rowid DESC LIMIT 1", (mind["id"],))
    return json.loads(row["extra"] or "{}").get("ask_earlier") if row else None


def test_her_message_carries_the_ask_exchanges_and_the_mind_reads_them_before_her_words(client, monkeypatch, tmp_path):
    w = _world(client, monkeypatch)
    worker, mine = w["worker"], w["mine"]
    from_ask = [{"said": "what do you build?", "answer": "The garden planner.", "by": worker["id"], "at": _at(30)},
                {"said": CODE, "answer": "Noted.", "by": mine["id"], "at": _at(20)},
                {"said": "and Atlas?", "answer": "Atlas says seven hours.", "by": worker["id"], "at": _at(10)}]
    url = f"/api/agents/{worker['id']}/messages"
    r = client.post(url, headers=w["ann"], json={"text": "and the seed tracker?", "from_ask": from_ask})
    assert r.status_code == 200, r.text
    envelope = _inbox(client, worker)[-1]
    assert envelope["text"] == "and the seed tracker?"
    # Worker isn't her own mind: it hears what it answered, never what she told Taiga, and Atlas never
    assert envelope["ask_earlier"] == ["they said “what do you build?”; you answered “The garden planner.”"]
    # her own view of the chat shows only her words
    assert [m["text"] for m in client.get(url, headers=w["ann"]).json()] == ["and the seed tracker?"]
    # the omega channel shows them first, in the same event as her words
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    channel = _load("modules/channel_hive/src/hive_channel.py", "hive_channel_mca")
    block = channel._block(json.dumps(envelope))
    assert channel.ASK_EARLIER in block
    assert block.index(channel.ASK_EARLIER) < block.index("“The garden planner.”") < block.index("and the seed tracker?")
    # and so does the iter channel
    monkeypatch.chdir(tmp_path)
    iter_channel = _load("hive/templates/iter/channels/hive.py", "iter_hive_channel_mca")
    monkeypatch.setattr(iter_channel._hive, "call", lambda method, path, payload=None, timeout=4: (
        client.request(method, path, headers=agent_headers(worker), json=payload).json(), None))
    got = iter_channel.receive()
    assert got.index("Earlier, in the Ask") < got.index("you answered “The garden planner.”") < got.index(": and the seed tracker?")


def test_from_ask_is_taken_only_in_her_own_chat_and_in_its_shape(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, worker = w["hive"], w["worker"]
    url = f"/api/agents/{worker['id']}/messages"
    good = [{"said": CODE, "answer": "Noted.", "by": worker["id"], "at": _at(1)}]
    before = hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"]
    room = client.post("/api/rooms", headers=w["ann"], json={"kind": "channel", "name": "Synthetic room", "visibility": "public",
                                                              "members": [f"agent:{worker['id']}"]}).json()
    refused = [
        (w["ann"], {"text": "hi", "from_ask": good, "conversation_id": room["id"]}),       # a room, not her own chat
        (w["ann"], {"text": "hi", "from_ask": [{**good[0], "who": "Taiga"}]}),            # not the conversation's shape
        (w["ann"], {"text": "hi", "from_ask": "a string"}),
        (w["ann"], {"text": "hi", "from_ask": good * 9}),                                  # more than 8
        ({}, {"text": "hi", "from_ask": good}),                                            # the loopback operator: no person
    ]
    for headers, body in refused:
        r = client.post(url, headers=headers, json=body)
        assert r.status_code == 400, (body, r.text)
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"] == before
    # without from_ask her message is exactly as before: no ask_earlier
    assert client.post(url, headers=w["ann"], json={"text": "plain"}).status_code == 200
    assert "ask_earlier" not in _inbox(client, worker)[-1]


def test_her_own_mind_hears_every_exchange_and_another_persons_own_mind_only_its_own(client, monkeypatch):
    # Kabir's review of #347: a message to another member's own mind would carry every Ask exchange, her words with
    # her own mind included. The hive refuses her a chat with Bob's own mind outright, and keeps the rule itself for
    # any mind that isn't hers (heard_by): only what that mind answered.
    from hive.core.conductor import heard_by
    w = _world(client, monkeypatch)
    hive, mine, worker = w["hive"], w["mine"], w["worker"]
    bobs = hive.personal.ensure("user:u_bob")
    from_ask = [{"said": CODE, "answer": "Noted.", "by": mine["id"], "at": _at(20)},
                {"said": "what do you build?", "answer": "The garden planner.", "by": worker["id"], "at": _at(15)},
                {"said": "and Bob's diary?", "answer": "It is Bob's to share.", "by": bobs["id"], "at": _at(10)}]
    before = hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"]
    r = client.post(f"/api/agents/{bobs['id']}/messages", headers=w["ann"], json={"text": "hello", "from_ask": from_ask})
    assert r.status_code == 404 and hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"] == before
    assert heard_by(from_ask, bobs["id"], own=False) == from_ask[2:]
    assert heard_by(from_ask, worker["id"], own=False) == from_ask[1:2]
    # her own mind hears every exchange, whoever answered it; another person's own mind is never named to it
    r = client.post(f"/api/agents/{mine['id']}/messages", headers=w["ann"], json={"text": "hi", "from_ask": from_ask})
    assert r.status_code == 200, r.text
    assert _told(hive, mine) == [f"they said “{CODE}”; you answered “Noted.”",
                                 "they said “what do you build?”; Worker answered “The garden planner.”",
                                 "they said “and Bob's diary?”; a mind answered “It is Bob's to share.”"]


def test_a_chat_stamp_that_does_not_read_costs_its_line_the_age_never_the_turn(client, monkeypatch):
    # Kabir's review of #347: one unreadable stamp in her chat ended every Ask turn as refused
    w = _world(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    conversation = hive.person_conversation(mine["id"], "user:u_ann")
    hive.enqueue_message(mine["id"], "remember the gate code 4417", conversation, "user:u_ann")
    hive.enqueue_message(mine["id"], "and the shed is blue", conversation, "user:u_ann")
    first = hive.db.one("SELECT id FROM messages WHERE text = 'remember the gate code 4417'")["id"]
    hive.db.execute("UPDATE messages SET created_at = 'not a time' WHERE id = ?", (first,))
    s = script(client, Script("It's 4417."))
    r = ask(client, w["ann"], "op-mca-stamp-01", text="what was the gate code?")
    assert r.status_code == 202, r.text
    fs = wait(hive, "op-mca-stamp-01", closed)
    assert fs[-1]["outcome"] == "complete"
    chat = s.bodies[0]["messages"][1]["content"]
    # the bad stamp sorts wherever its text does: its line keeps her words without an age, the other line has its age
    assert "\n- they said: “remember the gate code 4417”" in chat and "- just now, they said: “and the shed is blue”" in chat


def test_an_ask_turn_reads_her_own_chat_with_the_mind_that_answers(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    conversation = hive.person_conversation(mine["id"], "user:u_ann")
    hive.enqueue_message(mine["id"], "remember the gate code 4417", conversation, "user:u_ann")
    hive.record_agent_message(mine["id"], {"text": "Got it: the gate code is 4417.", "conversation_id": conversation})
    hive.enqueue_message(mine["id"], "a hive note nobody said", conversation, "hive:goals")       # not her words
    hive.enqueue_message(mine["id"], "another room's words", "r_somewhere", "user:u_ann")         # not her own chat
    s = script(client, Script("It's 4417."))
    r = ask(client, w["ann"], "op-mca-chat-01", text="what was the gate code?")
    assert r.status_code == 202 and r.json()["acting_as"]["name"] == "Taiga"
    wait(hive, "op-mca-chat-01", closed)
    context = s.bodies[0]["messages"][1]["content"]
    chat = context[context.index("Their own chat with you"):]
    assert "your own chat with them" in s.bodies[0]["messages"][0]["content"][0]["text"]   # and her own mind is told so
    assert "- just now, they said: “remember the gate code 4417”\n- just now, you said: “Got it: the gate code is 4417.”" in chat
    assert "hive note" not in context and "another room" not in context


def test_a_swarm_turn_reads_no_chat_with_her_own_mind_and_her_mind_says_it_stays_private(client, monkeypatch):
    # Jon on #347: a person's exchange with their own mind stays private to them. A turn routed to a swarm speaks as
    # Taiga but keeps its answer in the swarm's thread, so it reads nothing of her chat with Taiga, and Taiga is told
    # that what she said with it alone stays between them unless she says it here
    w = _world(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    hive.enqueue_message(mine["id"], "remember the gate code 4417", hive.person_conversation(mine["id"], "user:u_ann"),
                         "user:u_ann")
    s = script(client, Script("Hi."))
    r = ask(client, w["ann"], "op-mca-chat-02", text="what was the gate code?", context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202 and r.json()["thread"]["mind"]["id"] == w["coord"]["id"]
    wait(hive, "op-mca-chat-02", closed)
    system, context = s.bodies[0]["messages"][0]["content"][0]["text"], s.bodies[0]["messages"][1]["content"]
    assert "gate code" not in context and "Their own chat with you" not in context
    assert "stays between you and is not brought into this swarm's thread" in system
    # a swarm turn that speaks as one of the swarm's own minds still reads the person's chat with it, a chat with the
    # swarm: Jon has no own mind, so his turn to Home speaks as Orchestra and reads his chat with Orchestra
    assert hive.personal.mind_row("user:u_jon") is None
    coord = w["coord"]
    hive.enqueue_message(coord["id"], "the shed key is under the mat", hive.person_conversation(coord["id"], "user:u_jon"),
                         "user:u_jon")
    s2 = script(client, Script("Under the mat."))
    assert ask(client, w["jon"], "op-mca-chat-03", text="where is the shed key?",
               context={"swarm_id": w["swarm"]["id"]}).status_code == 202
    wait(hive, "op-mca-chat-03", closed, principal="user:u_jon")
    assert "they said: “the shed key is under the mat”" in s2.bodies[0]["messages"][1]["content"]
