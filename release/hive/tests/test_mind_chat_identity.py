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
    quinn = person(client, "u_mci_quinn", role="admin")
    url = f"/api/agents/{mind['id']}/messages"
    client.post(url, headers=ann, json={"text": "synthetic ann"})
    client.post(url, headers=bob, json={"text": "synthetic bob"})
    client.post(url, headers=quinn, json={"text": "synthetic quinn"})
    assert [m["text"] for m in client.get(url, headers=quinn).json()] == ["synthetic quinn"]
    audit = client.get(url, headers=quinn, params={"include": "all"}).json()
    assert [m["text"] for m in audit] == ["synthetic ann", "synthetic bob", "synthetic quinn"]
    assert [m["sender"] for m in audit] == ["user:u_mci_ann", "user:u_mci_bob", "user:u_mci_quinn"]
    assert [m["sender_name"] for m in audit] == ["u_mci_ann", "u_mci_bob", "u_mci_quinn"]


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
    quinn_v, loop_v = Viewer("user:u_mci_quinn", True), Viewer("user:operator", True)
    for frame in (a, reply):
        text = json.dumps({"type": "message", "message": frame})
        assert hive.visibility.event_visible(ann_v, text) is True
        assert hive.visibility.event_visible(bob_v, text) is False
        assert hive.visibility.event_visible(quinn_v, text) is False     # named admins audit over HTTP (?include=all)
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


def test_iter_channel_answers_one_conversation_at_a_time(client, tmp_path, monkeypatch):
    ann, bob, mind = _shared_mind(client)
    monkeypatch.chdir(tmp_path)
    iter_channel = _load("hive/templates/iter/channels/hive.py", "iter_hive_channel_mci")
    headers = agent_headers(mind)

    def call(method, path, payload=None, timeout=4):
        r = client.request(method, path, headers=headers, json=payload)
        return r.json(), None

    monkeypatch.setattr(iter_channel._hive, "call", call)
    url = f"/api/agents/{mind['id']}/messages"
    client.post(url, headers=ann, json={"text": "synthetic ann one"})
    client.post(url, headers=bob, json={"text": "synthetic bob one"})
    client.post(url, headers=ann, json={"text": "synthetic ann two"})
    assert iter_channel.receive() == "user:u_mci_ann: synthetic ann one"     # stops before bob's conversation
    assert iter_channel.receive() == ""                                     # ann waits for her answer: bob is held
    iter_channel.send("synthetic reply to ann")
    assert iter_channel.receive() == "user:u_mci_bob: synthetic bob one"
    iter_channel.send("synthetic reply to bob")
    assert iter_channel.receive() == "user:u_mci_ann: synthetic ann two"
    iter_channel.send("synthetic second reply to ann")
    assert [m["text"] for m in client.get(url, headers=ann).json()] == [
        "synthetic ann one", "synthetic ann two", "synthetic reply to ann", "synthetic second reply to ann"]
    assert [m["text"] for m in client.get(url, headers=bob).json()] == ["synthetic bob one", "synthetic reply to bob"]


# ---- r3: nobody speaks into another person's conversation; a new conversation is bound to its creator ------------

def test_nobody_posts_into_another_persons_conversation_admins_and_operator_included(client):
    ann, bob, mind = _shared_mind(client)
    quinn = person(client, "u_mci_quinn", role="admin")
    url = f"/api/agents/{mind['id']}/messages"
    a = client.post(url, headers=ann, json={"text": "synthetic ann"}).json()
    for who in (quinn, {}):                               # a named admin, then the loopback operator (client default)
        r = client.post(url, headers=who, json={"text": "synthetic cross-post", "conversation_id": a["conversation_id"]})
        assert r.status_code == 404, r.text
    assert [m["text"] for m in client.get(url, headers=ann).json()] == ["synthetic ann"]
    audit = client.get(url, headers=quinn, params={"include": "all"}).json()     # audit stays read-only and complete
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
    quinn = person(client, "u_mci_quinn", role="admin")
    hive = client.app.state.hive
    hive.enqueue_message(mind["id"], "synthetic legacy ann", "c_legacy_ann", "user:u_mci_ann")   # pre-namespace shape
    assert hive.conversation_owner(mind["id"], "c_legacy_ann") == "user:u_mci_ann"
    url = f"/api/agents/{mind['id']}/messages"
    for who in ({}, quinn, bob):
        r = client.post(url, headers=who, json={"text": "synthetic intrusion", "conversation_id": "c_legacy_ann"})
        assert r.status_code == 404, r.text
    assert [m["text"] for m in client.get(url, headers=ann, params={"conversation_id": "c_legacy_ann"}).json()] == [
        "synthetic legacy ann"]
    # the loopback operator's own conversation and its own new ids are unchanged
    assert client.post(url, json={"text": "synthetic op", "conversation_id": "c_operator_topic"}).status_code == 200
    assert client.post(url, json={"text": "synthetic op"}).status_code == 200
