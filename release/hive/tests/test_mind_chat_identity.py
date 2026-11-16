"""Mind chat identity and privacy (platform mind-chat-identity r1). Synthetic people and minds only.

- a named person's message reaches the mind as that person, never as user:operator (the loopback operator is unchanged);
- people who share a mind each read only their own conversation with it; an admin audits all with ?include=all;
- live message frames follow the same rule.
"""
import json

from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client  # noqa: F401
from hive.tests.test_visibility import person


def _shared_mind(client):
    ann, bob = person(client, "u_mci_ann"), person(client, "u_mci_bob")
    swarm = client.post("/api/swarms", headers=ann, json={"name": "Synthetic shared lab"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Synthetic Ada", "kind": "module", "swarm_id": swarm["id"]}).json()
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann,
                      json={"visibility": "shared", "shared_with": ["user:u_mci_bob"]}).status_code == 200
    return ann, bob, mind


def _inbox(client, mind):
    out = client.get("/api/agent/inbox", headers=agent_headers(mind), params={"after": 0}).json()["messages"]
    return [json.loads(m["text"]) for m in out]


def _reply(client, mind, conversation_id, text):
    r = client.post("/api/agent/messages", headers=agent_headers(mind), json={"text": text, "conversation_id": conversation_id})
    assert r.status_code == 200, r.text
    return r.json()


def test_two_people_reach_the_mind_as_themselves_and_read_only_their_own_conversation(client):
    ann, bob, mind = _shared_mind(client)
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic hello from ann"})
    b = client.post(url, headers=bob, json={"text": "synthetic hello from bob"})
    assert a.status_code == 200 and b.status_code == 200
    a, b = a.json(), b.json()
    assert a["sender"] == "user:u_mci_ann" and b["sender"] == "user:u_mci_bob"
    assert a["sender_name"] == "u_mci_ann" and b["sender_name"] == "u_mci_bob"
    assert a["conversation_id"] != b["conversation_id"]

    envelopes = _inbox(client, mind)
    assert [e["sender"] for e in envelopes] == ["user:u_mci_ann", "user:u_mci_bob"]   # two distinct senders, never operator
    assert all(e["sender"] != "user:operator" for e in envelopes)
    assert {e["conversation_id"] for e in envelopes} == {a["conversation_id"], b["conversation_id"]}

    _reply(client, mind, a["conversation_id"], "synthetic reply to ann")
    _reply(client, mind, b["conversation_id"], "synthetic reply to bob")

    ann_view = client.get(url, headers=ann).json()
    bob_view = client.get(url, headers=bob).json()
    assert [m["text"] for m in ann_view] == ["synthetic hello from ann", "synthetic reply to ann"]
    assert [m["text"] for m in bob_view] == ["synthetic hello from bob", "synthetic reply to bob"]
    assert ann_view[1]["sender"] == f"agent:{mind['id']}" and ann_view[1]["sender_name"] == "Synthetic Ada"
    # asking for the other person's conversation by id yields nothing
    assert client.get(url, headers=bob, params={"conversation_id": a["conversation_id"]}).json() == []
    # and nobody posts into another person's conversation
    r = client.post(url, headers=bob, json={"text": "synthetic intrusion", "conversation_id": a["conversation_id"]})
    assert r.status_code == 404
    r = client.post(url, headers=bob, json={"text": "synthetic intrusion", "conversation_id": f"c_{mind['id']}"})
    assert r.status_code == 404
    # a non-admin cannot opt into the audit view
    assert client.get(url, headers=bob, params={"include": "all"}).status_code == 403


def test_admin_opt_in_sees_all_and_default_is_own(client):
    ann, bob, mind = _shared_mind(client)
    jon = person(client, "u_mci_jon", role="admin")
    url = f"/api/agents/{mind['id']}/messages"
    client.post(url, headers=ann, json={"text": "synthetic ann"})
    client.post(url, headers=bob, json={"text": "synthetic bob"})
    client.post(url, headers=jon, json={"text": "synthetic jon"})
    assert [m["text"] for m in client.get(url, headers=jon).json()] == ["synthetic jon"]
    audit = client.get(url, headers=jon, params={"include": "all"}).json()
    assert [m["text"] for m in audit] == ["synthetic ann", "synthetic bob", "synthetic jon"]
    assert [m["sender"] for m in audit] == ["user:u_mci_ann", "user:u_mci_bob", "user:u_mci_jon"]
    assert [m["sender_name"] for m in audit] == ["u_mci_ann", "u_mci_bob", "u_mci_jon"]


def test_loopback_operator_is_unchanged(client):
    ann, _bob, mind = _shared_mind(client)
    url = f"/api/agents/{mind['id']}/messages"
    sent = client.post(url, json={"text": "synthetic operator note"}).json()   # the hive-password session
    assert sent["sender"] == "user:operator" and sent["conversation_id"] == f"c_{mind['id']}"
    assert sent["sender_name"] is None
    assert _inbox(client, mind)[0]["sender"] == "user:operator"
    client.post(url, headers=ann, json={"text": "synthetic ann"})
    # the loopback operator still reads the whole stream; a named person never sees the operator's chat as theirs
    assert [m["text"] for m in client.get(url).json()] == ["synthetic operator note", "synthetic ann"]
    assert [m["text"] for m in client.get(url, headers=ann).json()] == ["synthetic ann"]


def test_legacy_operator_rows_are_not_shown_to_named_people(client):
    ann, bob, mind = _shared_mind(client)
    hive = client.app.state.hive
    hive.enqueue_message(mind["id"], "synthetic legacy line", None, "user:operator")       # pre-fix storage shape
    _reply(client, mind, f"c_{mind['id']}", "synthetic legacy reply")
    hive.enqueue_message(mind["id"], "[GOAL-NOTE] synthetic system note", None, "hive:goals")
    url = f"/api/agents/{mind['id']}/messages"
    for who in (ann, bob):
        texts = [m["text"] for m in client.get(url, headers=who).json()]
        assert "synthetic legacy line" not in texts and "synthetic legacy reply" not in texts
        assert "[GOAL-NOTE] synthetic system note" in texts          # the mind's system notes keep their old rule
    stored = hive.db.one("SELECT sender FROM messages WHERE text = ?", ("synthetic legacy line",))
    assert stored["sender"] == "user:operator"                       # storage untouched


def test_live_message_frames_do_not_leak_between_people(client):
    ann, bob, mind = _shared_mind(client)
    hive = client.app.state.hive
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic ann"}).json()
    reply = _reply(client, mind, a["conversation_id"], "synthetic reply to ann")
    ann_v, bob_v = Viewer("user:u_mci_ann", False), Viewer("user:u_mci_bob", False)
    jon_v, loop_v = Viewer("user:u_mci_jon", True), Viewer("user:operator", True)
    for frame in (a, reply):
        text = json.dumps({"type": "message", "message": frame})
        assert hive.visibility.event_visible(ann_v, text) is True
        assert hive.visibility.event_visible(bob_v, text) is False
        assert hive.visibility.event_visible(jon_v, text) is False     # named admins audit over HTTP (?include=all)
        assert hive.visibility.event_visible(loop_v, text) is True     # loopback unchanged


def test_published_frames_are_scoped(client, monkeypatch):
    """The frames the hive actually publishes for a person's message and the mind's reply (not hand-built ones)."""
    ann, bob, mind = _shared_mind(client)
    hive = client.app.state.hive
    frames = []
    real = hive.events.publish

    def capture(kind, /, **payload):
        frames.append(json.dumps(dict(type=kind, at="t", **payload)))
        return real(kind, **payload)

    monkeypatch.setattr(hive.events, "publish", capture)
    a = client.post(f"/api/agents/{mind['id']}/messages", headers=ann, json={"text": "synthetic ann"}).json()
    _reply(client, mind, a["conversation_id"], "synthetic reply to ann")
    chat = [f for f in frames if f.startswith('{"type": "message"')]
    assert len(chat) == 2
    for text in chat:
        assert hive.visibility.event_visible(Viewer("user:u_mci_ann", False), text) is True
        assert hive.visibility.event_visible(Viewer("user:u_mci_bob", False), text) is False


def test_posting_into_a_room_conversation_needs_membership(client):
    """r2: the direct mind route speaks into a room's conversation only for that room's members (as the room route)."""
    ann, bob, mind = _shared_mind(client)
    url = f"/api/agents/{mind['id']}/messages"
    dm = client.post("/api/rooms", headers=ann, json={"kind": "dm", "members": [f"agent:{mind['id']}"]}).json()
    channel = client.post("/api/rooms", headers=ann, json={"kind": "channel", "name": "Synthetic open channel",
                                                            "visibility": "public", "members": [f"agent:{mind['id']}"]}).json()
    # Bob cannot see Ann's DM with the mind: not found; he can see the public channel but is not in it: refused
    assert client.post(url, headers=bob, json={"text": "synthetic", "conversation_id": dm["id"]}).status_code == 404
    r = client.post(url, headers=bob, json={"text": "synthetic", "conversation_id": channel["id"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_member"
    assert client.post(f"/api/rooms/{channel['id']}/messages", headers=bob, json={"text": "synthetic"}).status_code == 403
    # members still speak there through this route, as themselves
    sent = client.post(url, headers=ann, json={"text": "synthetic member", "conversation_id": channel["id"]})
    assert sent.status_code == 200 and sent.json()["sender"] == "user:u_mci_ann"
    hive = client.app.state.hive
    assert not hive.db.one("SELECT 1 FROM messages WHERE agent_id = ? AND sender = ?", (mind["id"], "user:u_mci_bob"))


# ---- r2: the mind's side binds each reply to the conversation it answers -----------------------------------------

import importlib.util  # noqa: E402
import pathlib  # noqa: E402

_REPO = pathlib.Path(__file__).resolve().parents[2]


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, _REPO / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _deliver_outbox(client, mind, folder, start):
    """Post the channel's queued agent_message frames to the hive as the mind's hub connection would."""
    lines = (folder / "outbox.jsonl").read_text().splitlines() if (folder / "outbox.jsonl").exists() else []
    for line in lines[start:]:
        frame = json.loads(line)
        _reply(client, mind, frame.get("conversation_id"), frame["text"])
    return len(lines)


def test_interleaved_people_each_get_their_own_reply_through_the_channel(client, tmp_path, monkeypatch):
    ann, bob, mind = _shared_mind(client)
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    channel = _load("modules/channel_hive/src/hive_channel.py", "hive_channel_mci")
    folder = channel.channel_dir()
    folder.mkdir(parents=True, exist_ok=True)
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic question from ann"}).json()
    b = client.post(url, headers=bob, json={"text": "synthetic question from bob"}).json()
    blocks = [channel._block(json.dumps(e)) for e in _inbox(client, mind)]       # one turn holds both people
    assert all(f"explicit_reply_affordance=send-hive-to {c} message" in blk
               for blk, c in zip(blocks, (a["conversation_id"], b["conversation_id"])))
    refused = channel.send_message("synthetic answer meant for ann")
    assert refused.startswith("HIVE-REPLY-AMBIGUOUS") and not (folder / "outbox.jsonl").exists()   # fail closed
    assert channel.send_to("c_someone_else", "synthetic").startswith("HIVE-REPLY-UNKNOWN-CONVERSATION")
    assert channel.send_to(a["conversation_id"], "synthetic answer for ann") == "HIVE-MESSAGE-QUEUED"
    assert channel.send_message("synthetic answer for bob") == "HIVE-MESSAGE-QUEUED"   # only bob is waiting now
    sent = _deliver_outbox(client, mind, folder, 0)

    # ann writes again while bob's next message is also waiting: a plain send never picks "last received"
    client.post(url, headers=ann, json={"text": "synthetic follow-up from ann"})
    client.post(url, headers=bob, json={"text": "synthetic follow-up from bob"})
    for e in _inbox(client, mind)[2:]:
        channel._block(json.dumps(e))
    assert channel.send_message("synthetic ambiguous").startswith("HIVE-REPLY-AMBIGUOUS")
    channel.send_to(b["conversation_id"], "synthetic second answer for bob")
    channel.send_message("synthetic second answer for ann")
    _deliver_outbox(client, mind, folder, sent)

    ann_view = [m["text"] for m in client.get(url, headers=ann).json()]
    bob_view = [m["text"] for m in client.get(url, headers=bob).json()]
    assert ann_view == ["synthetic question from ann", "synthetic answer for ann", "synthetic follow-up from ann",
                        "synthetic second answer for ann"]
    assert bob_view == ["synthetic question from bob", "synthetic answer for bob", "synthetic follow-up from bob",
                        "synthetic second answer for bob"]


def test_omega_channel_a_minds_dm_never_makes_a_persons_reply_ambiguous_and_a_refusal_is_shown(client, tmp_path, monkeypatch):
    """A conversation from another mind (or the hive) does not wait for an answer, so a plain send still answers the one
    person waiting; when two people wait, the refused send is shown to the mind on its next receive (the owner,
    2026-11-11: Omega drops send's return value, so it was silent)."""
    ann, bob, mind = _shared_mind(client)
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    channel = _load("modules/channel_hive/src/hive_channel.py", "hive_channel_mci_dm")
    folder = channel.channel_dir()
    folder.mkdir(parents=True, exist_ok=True)
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic question from ann"}).json()
    channel._block(json.dumps(_inbox(client, mind)[0]))
    channel._block(json.dumps({"hive": 1, "sender": "agent:a_00000000", "sender_name": "Peer", "conversation_id": "r_peerdm",
                               "message_id": "m_x", "text": "thanks, standing by"}))
    channel._block(json.dumps({"hive": 1, "sender": "hive:goals", "conversation_id": "c_goalnotes", "message_id": "m_y",
                               "text": "[GOAL-NOTE] synthetic"}))
    assert channel.send_message("synthetic answer for ann") == "HIVE-MESSAGE-QUEUED"     # the mind DM did not block it
    frame = json.loads((folder / "outbox.jsonl").read_text().splitlines()[-1])
    assert frame["conversation_id"] == a["conversation_id"]
    assert channel.send_to("r_peerdm", "synthetic answer for peer") == "HIVE-MESSAGE-QUEUED"   # still answerable by id
    # two people waiting: refused (fail closed, John's rule), and the mind is told on its next receive
    client.post(url, headers=ann, json={"text": "synthetic follow-up from ann"})
    client.post(url, headers=bob, json={"text": "synthetic question from bob"})
    for e in _inbox(client, mind)[1:]:
        channel._block(json.dumps(e))
    lines = (folder / "outbox.jsonl").read_text().splitlines()
    assert channel.send_message("synthetic unsure answer").startswith("HIVE-REPLY-AMBIGUOUS")
    assert (folder / "outbox.jsonl").read_text().splitlines() == lines                   # nothing sent
    told = channel.getLastMessage()
    assert told.startswith("HIVE-REPLY-AMBIGUOUS nothing was sent") and "synthetic unsure answer" in told
    assert "HIVE-REPLY-AMBIGUOUS" not in channel.getLastMessage()                         # told once


def test_omega_channel_the_hives_hello_in_a_persons_conversation_waits_for_the_minds_answer(client, tmp_path, monkeypatch):
    """First Light's hello is written by the hive (hive:first-light) into the person's own conversation; that
    conversation waits for the mind's greeting, so the greeting answers it (Mesto, flagship #82, 2026-11-11: the
    sender-based skip left it unanswered and First Light never finished)."""
    ann, bob, mind = _shared_mind(client)
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    channel = _load("modules/channel_hive/src/hive_channel.py", "hive_channel_mci_hello")
    folder = channel.channel_dir()
    folder.mkdir(parents=True, exist_ok=True)
    conversation = f"c_{mind['id']}~user:u_ann"
    channel._block(json.dumps({"hive": 1, "sender": "hive:first-light", "conversation_id": conversation,
                               "message_id": "m_hello", "event": "first_light_hello", "text": "synthetic hello"}))
    assert channel.send_message("synthetic greeting for ann") == "HIVE-MESSAGE-QUEUED"
    frame = json.loads((folder / "outbox.jsonl").read_text().splitlines()[-1])
    assert frame["conversation_id"] == conversation


def test_iter_channel_never_holds_a_conversation_back_and_replies_where_it_is_told(client, tmp_path, monkeypatch):
    """Every new message is handed over at once, marked by conversation; send answers the latest one, hive_send_to any
    other by its id; an unanswered conversation (a person's or a mind's) never blocks the next (the owner, 2026-11-11)."""
    ann, bob, mind = _shared_mind(client)
    monkeypatch.chdir(tmp_path)
    iter_channel = _load("hive/templates/iter/channels/hive.py", "iter_hive_channel_mci")
    send_to = _load("hive/templates/iter/tools/hive_send_to.py", "iter_hive_send_to_mci")
    headers = agent_headers(mind)

    def call(method, path, payload=None, timeout=4):
        r = client.request(method, path, headers=headers, json=payload)
        return r.json(), None

    monkeypatch.setattr(iter_channel._hive, "call", call)
    monkeypatch.setattr(send_to._hive, "call", call)
    url = f"/api/agents/{mind['id']}/messages"
    a1 = client.post(url, headers=ann, json={"text": "synthetic ann one"}).json()
    b1 = client.post(url, headers=bob, json={"text": "synthetic bob one"}).json()
    got = iter_channel.receive()                                          # both at once, each marked
    assert f"[conversation {a1['conversation_id']}] u_mci_ann (user:u_mci_ann): synthetic ann one" in got
    assert f"[conversation {b1['conversation_id']}] u_mci_bob (user:u_mci_bob): synthetic bob one" in got
    iter_channel.send("synthetic reply to bob")                           # the latest: bob's
    assert send_to.run(a1["conversation_id"], "synthetic reply to ann") == f"sent to {a1['conversation_id']}"
    client.post(url, headers=ann, json={"text": "synthetic ann two"})
    assert iter_channel.receive() == "u_mci_ann (user:u_mci_ann): synthetic ann two"   # one conversation: no marks
    # ann's is not answered now; bob's next message still comes through at once
    client.post(url, headers=bob, json={"text": "synthetic bob two"})
    assert iter_channel.receive() == "u_mci_bob (user:u_mci_bob): synthetic bob two"
    iter_channel.send("synthetic second reply to bob")
    assert [m["text"] for m in client.get(url, headers=ann).json()] == [
        "synthetic ann one", "synthetic reply to ann", "synthetic ann two"]
    assert [m["text"] for m in client.get(url, headers=bob).json()] == [
        "synthetic bob one", "synthetic reply to bob", "synthetic bob two", "synthetic second reply to bob"]
    assert not (tmp_path / ".hive_waiting").exists()


# ---- r3: nobody speaks into another person's conversation; a new conversation is bound to its creator ------------

def test_nobody_posts_into_another_persons_conversation_admins_and_operator_included(client):
    ann, bob, mind = _shared_mind(client)
    jon = person(client, "u_mci_jon", role="admin")
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic ann"}).json()
    for who in (jon, {}):                               # a named admin, then the loopback operator (client default)
        r = client.post(url, headers=who, json={"text": "synthetic cross-post", "conversation_id": a["conversation_id"]})
        assert r.status_code == 404, r.text
    assert [m["text"] for m in client.get(url, headers=ann).json()] == ["synthetic ann"]
    audit = client.get(url, headers=jon, params={"include": "all"}).json()     # audit stays read-only and complete
    assert [m["text"] for m in audit] == ["synthetic ann"]


def test_a_person_cannot_claim_an_unowned_or_foreign_conversation_id(client):
    ann, bob, mind = _shared_mind(client)
    hive = client.app.state.hive
    url = f"/api/agents/{mind['id']}/messages"
    hive.enqueue_message(mind["id"], "[GOAL-NOTE] synthetic", "c_unowned_notes", "hive:goals")   # unknown ownership
    for conversation in ("c_brand_new_id", "c_unowned_notes", f"c_{mind['id']}~user:u_mci_ann~topic",
                         f"c_{mind['id']}~user:u_mci_ann", f"c_{mind['id']}"):
        r = client.post(url, headers=bob, json={"text": "synthetic claim", "conversation_id": conversation})
        assert r.status_code == 404, (conversation, r.text)
    assert not hive.db.one("SELECT 1 FROM messages WHERE sender = ?", ("user:u_mci_bob",))
    # a new conversation in the person's own namespace is theirs from its first message
    mine = f"c_{mind['id']}~user:u_mci_bob~topic"
    sent = client.post(url, headers=bob, json={"text": "synthetic bob topic", "conversation_id": mine})
    assert sent.status_code == 200 and sent.json()["conversation_id"] == mine
    assert hive.conversation_owner(mind["id"], mine) == "user:u_mci_bob"
    _reply(client, mind, mine, "synthetic reply on bob topic")
    topic = {"conversation_id": mine}
    assert [m["text"] for m in client.get(url, headers=bob, params=topic).json()] == ["synthetic bob topic",
                                                                                      "synthetic reply on bob topic"]
    assert client.get(url, headers=ann, params=topic).json() == []
    assert "synthetic bob topic" not in [m["text"] for m in client.get(url, headers=ann).json()]


def test_legacy_conversation_owned_by_a_person_is_theirs_alone_loopback_included(client):
    """r4 (stand-in P1): a legacy conversation id owned by its first person speaker refuses everyone else, the loopback
    operator and admins included."""
    ann, bob, mind = _shared_mind(client)
    jon = person(client, "u_mci_jon", role="admin")
    hive = client.app.state.hive
    hive.enqueue_message(mind["id"], "synthetic legacy ann", "c_legacy_ann", "user:u_mci_ann")   # pre-namespace shape
    assert hive.conversation_owner(mind["id"], "c_legacy_ann") == "user:u_mci_ann"
    url = f"/api/agents/{mind['id']}/messages"
    for who in ({}, jon, bob):
        r = client.post(url, headers=who, json={"text": "synthetic intrusion", "conversation_id": "c_legacy_ann"})
        assert r.status_code == 404, r.text
    assert [m["text"] for m in client.get(url, headers=ann, params={"conversation_id": "c_legacy_ann"}).json()] == [
        "synthetic legacy ann"]
    # the loopback operator's own conversation and its own new ids are unchanged
    assert client.post(url, json={"text": "synthetic op", "conversation_id": "c_operator_topic"}).status_code == 200
    assert client.post(url, json={"text": "synthetic op"}).status_code == 200
