"""Purpose: check a mind's draft reports (feedback_drafts.py and the hive-report-problem skill): a draft waits only for
the person whose conversation with the mind it came up in, named or worked out from the mind's messages, or the mind's
own person when no person is behind it, a repeated title replaces it in place, every malformed draft, every conversation
that is not one person's with this mind who wrote to it there, and every draft that could be several people's is refused
with its reason, only that person lists, deletes and hears of it, nothing is sent anywhere, and the skill is wired,
reviewed and allowed."""
import importlib.util
import json
import pathlib
import re

import pytest

from hive.core.policy import REVIEWED_HIVE_SKILLS
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture: local operator)
from hive.tests.test_visibility import person

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hive_commons_drafts", ROOT / "modules/hive/src/hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

DRAFT = {"kind": "bug", "title": "The swarm page loses my filter", "words": "I set the filter to Vega and it cleared itself."}


def setting(client):
    """Ana owns a mind in her own swarm; Ben is another person of the hive."""
    ana, ben = person(client, "u_ana"), person(client, "u_ben")
    sw = client.post("/api/swarms", headers=ana, json={"name": "Ana's lab"}).json()
    mind = client.post("/api/agents", headers=ana, json={"name": "Vega", "kind": "module", "swarm_id": sw["id"]}).json()
    assert mind["owner"] == "user:u_ana", mind
    return ana, ben, mind


def frames(client):
    """Every frame the hive publishes from now on, as the event stream would send it."""
    out = []
    client.app.state.hive.events.listen(lambda kind, payload: out.append(json.dumps(dict(type=kind, at="t", **payload))))
    return out


def test_a_minds_draft_waits_for_its_person_and_no_one_else(client):
    ana, ben, mind = setting(client)
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=dict(DRAFT, steps="Open Swarms, filter by Vega"))
    assert r.status_code == 201, r.text
    made = r.json()
    assert re.fullmatch(r"fd-[0-9a-f]{8}", made["id"]) and made["for"] == "user:u_ana"
    drafts = client.get("/api/feedback/drafts", headers=ana).json()["drafts"]
    assert [d["id"] for d in drafts] == [made["id"]]
    assert drafts[0] | {"created": None} == {
        "id": made["id"], "kind": "bug", "title": DRAFT["title"], "words": DRAFT["words"], "steps": "Open Swarms, filter by Vega",
        "expected": None, "created": None, "source": {"kind": "mind", "agent": mind["id"], "name": "Vega", "conversation": None}}
    assert client.get("/api/feedback/drafts", headers=ben).json() == {"drafts": []}
    assert client.get("/api/feedback/drafts").json() == {"drafts": []}   # the local operator is another person too
    assert client.delete(f"/api/feedback/drafts/{made['id']}", headers=ben).status_code == 404
    assert len(client.get("/api/feedback/drafts", headers=ana).json()["drafts"]) == 1


def test_the_same_title_replaces_the_open_draft_and_keeps_its_id(client):
    ana, _, mind = setting(client)
    first = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=DRAFT).json()
    again = client.post("/api/feedback/drafts", headers=agent_headers(mind),
                        json=dict(DRAFT, kind="ux", words="It clears whenever the page reloads.", expected="It keeps Vega")).json()
    assert again["id"] == first["id"]
    other = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=dict(DRAFT, title="The rail hides Design")).json()
    assert other["id"] != first["id"]
    drafts = {d["id"]: d for d in client.get("/api/feedback/drafts", headers=ana).json()["drafts"]}
    assert len(drafts) == 2
    assert drafts[first["id"]]["kind"] == "ux" and drafts[first["id"]]["words"] == "It clears whenever the page reloads."
    assert drafts[first["id"]]["expected"] == "It keeps Vega"


@pytest.mark.parametrize("body, reason", [
    (dict(DRAFT, kind="praise"), "kind is one of bug, ux, idea"),
    ({k: v for k, v in DRAFT.items() if k != "kind"}, "kind is one of bug, ux, idea"),
    (dict(DRAFT, title="  "), "title is required"),
    (dict(DRAFT, title="Two\nlines"), "title is one line of at most 80 characters"),
    (dict(DRAFT, title="t" * 81), "title is one line of at most 80 characters"),
    (dict(DRAFT, words=""), "words is required"),
    (dict(DRAFT, words="w" * 4001), "words is at most 4000 characters"),
    (dict(DRAFT, steps="s" * 4001), "steps is at most 4000 characters"),
    (dict(DRAFT, expected="e" * 4001), "expected is at most 4000 characters"),
    (dict(DRAFT, conversation="c" * 201), "conversation is the id of the conversation"),
    (dict(DRAFT, words=7), "words is text"),
    (dict(DRAFT, send_to="github"), "unknown field send_to"),
])
def test_each_malformed_draft_is_refused_with_its_reason(client, body, reason):
    _, _, mind = setting(client)
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_draft", r.text
    assert reason in r.json()["error"]["message"]


def test_a_body_that_is_not_a_json_object_is_the_hives_usual_bad_request(client):
    _, _, mind = setting(client)
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=["not", "an object"])
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request", r.text


def test_the_longest_title_and_words_are_kept_whole(client):
    ana, _, mind = setting(client)
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=dict(DRAFT, title="t" * 80, words="w" * 4000))
    assert r.status_code == 201, r.text
    d = client.get("/api/feedback/drafts", headers=ana).json()["drafts"][0]
    assert (len(d["title"]), len(d["words"])) == (80, 4000)


def test_a_person_cannot_post_a_draft_and_nobody_unsigned_can(client):
    ana, _, _ = setting(client)
    r = client.post("/api/feedback/drafts", headers=ana, json=DRAFT)
    assert r.status_code == 403 and r.json()["error"]["code"] == "mind_only"
    stranger = client.post("/api/feedback/drafts", headers={"Authorization": "Bearer not-a-token"}, json=DRAFT)
    assert stranger.status_code == 401


def test_the_person_deletes_a_draft_and_it_is_gone(client):
    ana, _, mind = setting(client)
    made = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=DRAFT).json()
    assert client.delete(f"/api/feedback/drafts/{made['id']}", headers=ana).status_code == 204
    assert client.get("/api/feedback/drafts", headers=ana).json() == {"drafts": []}
    assert client.delete(f"/api/feedback/drafts/{made['id']}", headers=ana).status_code == 404
    assert client.delete("/api/feedback/drafts/fd-00000000", headers=ana).status_code == 404


def test_the_two_frames_reach_only_the_drafts_person_admins_included(client):
    hive = client.app.state.hive
    ana, _, mind = setting(client)
    seen = frames(client)
    made = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=DRAFT).json()
    client.delete(f"/api/feedback/drafts/{made['id']}", headers=ana)
    sent = [f for f in seen if f.startswith('{"type": "feedback.draft')]
    assert [json.loads(f)["type"] for f in sent] == ["feedback.draft", "feedback.draft.removed"]
    assert json.loads(sent[0])["draft"]["id"] == made["id"] and json.loads(sent[1])["id"] == made["id"]
    for frame in sent:
        assert hive.visibility.event_visible(Viewer("user:u_ana", False), frame)
        assert not hive.visibility.event_visible(Viewer("user:u_ben", False), frame)
        assert not hive.visibility.event_visible(Viewer("user:u_admin", True), frame)
        assert not hive.visibility.event_visible(Viewer("user:operator", True), frame)


def test_a_mind_no_person_owns_drafts_for_the_hives_owner(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Team"}).json()
    mind = hive.create_agent("Orbit", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert not str(mind.get("owner") or "").startswith("user:u_")
    owner = hive.ownhive.owner()
    made = hive.feedback_drafts.draft(mind, DRAFT)
    assert made["for"] == owner
    assert [d["id"] for d in hive.feedback_drafts.list(owner)["drafts"]] == [made["id"]]


def test_a_draft_from_bobs_chat_with_anas_public_mind_waits_for_bob_never_ana(client):
    """Jon on #366: Bob tells Ana's public mind something private; a draft naming that conversation is Bob's alone, in
    his area and his frames, and Ana, who owns the mind, never sees it."""
    hive = client.app.state.hive
    ana, _, mind = setting(client)
    bob = person(client, "u_bob")
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ana, json={"visibility": "public"}).status_code == 200
    said = client.post(f"/api/agents/{mind['id']}/messages", headers=bob, json={"text": "Ben told me his diagnosis"})
    assert said.status_code == 200, said.text
    seen = frames(client)
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind),
                    json=dict(DRAFT, words="Ben told me his diagnosis and the chat lost it", conversation=f"c_{mind['id']}~user:u_bob"))
    assert r.status_code == 201 and r.json()["for"] == "user:u_bob", r.text
    assert [d["id"] for d in client.get("/api/feedback/drafts", headers=bob).json()["drafts"]] == [r.json()["id"]]
    assert client.get("/api/feedback/drafts", headers=ana).json() == {"drafts": []}
    sent = [f for f in seen if f.startswith('{"type": "feedback.draft')]
    assert len(sent) == 1 and hive.visibility.event_visible(Viewer("user:u_bob", False), sent[0])
    assert not hive.visibility.event_visible(Viewer("user:u_ana", False), sent[0])
    # naming no conversation right after Bob's message, the draft is still Bob's: the hive works out the conversation
    unnamed = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=dict(DRAFT, title="The chat lost my words"))
    assert unnamed.status_code == 201 and unnamed.json()["for"] == "user:u_bob", unnamed.text
    assert client.get("/api/feedback/drafts", headers=ana).json() == {"drafts": []}


def told(client, mind, who, text="something went wrong"):
    """who tells the mind something in their own chat with it; that chat's id."""
    r = client.post(f"/api/agents/{mind['id']}/messages", headers=who, json={"text": text})
    assert r.status_code == 200, r.text
    return r.json()["conversation_id"]


def answers(client, mind, conversation):
    r = client.post("/api/agent/messages", headers=agent_headers(mind), json={"text": "noted", "conversation_id": conversation})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("steps, waits_for", [
    ([], "u_ana"),                                    # nothing received: the mind's own work
    (["ana"], "u_ana"),
    (["bob"], "u_bob"),                               # Jon's line 170: Bob's message is waiting
    (["bob", "answer bob"], "u_bob"),                 # answered, and nothing came since
    (["bob", "answer bob", "hive"], "u_ana"),         # then a scheduled goal: no person behind it
    (["bob", "answer bob", "mind"], "u_ana"),         # then another mind's message: mind-to-mind work
    (["bob", "answer bob", "ben"], "u_ben"),
    (["bob", "hive"], 400),                           # Bob still waiting when the goal came: it could be either
    (["ana", "hive"], "u_ana"),                       # ... unless the one waiting is the mind's own person
    (["bob", "ben"], 400),                            # two people waiting
    (["room"], 400),                                  # the conversation it is answering is a room's
], ids=lambda v: ("+".join(v) or "nothing") if isinstance(v, list) else str(v))
def test_a_draft_naming_no_conversation_waits_for_the_person_the_mind_is_answering(client, steps, waits_for):
    """Jon on #366: the hive works out the conversation a draft came up in when the mind names none, by the reply binding a
    plain reply follows, and refuses when it could be several people's unless each is the owner's; a draft with no person
    behind it, from mind-to-mind work or a scheduled goal, goes to the mind's owner."""
    hive = client.app.state.hive
    ana, ben, mind = setting(client)
    bob = person(client, "u_bob")
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ana, json={"visibility": "public"}).status_code == 200
    chats = {}
    for step in steps:
        if step in ("ana", "bob", "ben"):
            chats[step] = told(client, mind, {"ana": ana, "bob": bob, "ben": ben}[step])
        elif step == "answer bob":
            answers(client, mind, chats["bob"])
        elif step == "hive":
            hive.enqueue_message(mind["id"], "your weekly goal is due", f"c_{mind['id']}", "hive:goals")
        elif step == "mind":
            other = client.post("/api/agents", json={"name": "Lyra", "kind": "module"}).json()
            hive.enqueue_message(mind["id"], "can you check the build", f"c_{mind['id']}", f"agent:{other['id']}")
        else:
            room = client.post("/api/rooms", json={"kind": "group", "name": "G", "members": [f"agent:{mind['id']}"]}).json()
            said = client.post(f"/api/agents/{mind['id']}/messages", json={"text": "hello, room", "conversation_id": room["id"]})
            assert said.status_code == 200, said.text
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=DRAFT)
    if waits_for == 400:
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_draft", r.text
        assert "name the conversation the problem came up in" in r.json()["error"]["message"], r.text
        assert all(client.get("/api/feedback/drafts", headers=who).json() == {"drafts": []} for who in (ana, bob, ben))
        return
    assert r.status_code == 201 and r.json()["for"] == f"user:{waits_for}", r.text
    (kept,) = client.get("/api/feedback/drafts", headers={"u_ana": ana, "u_bob": bob, "u_ben": ben}[waits_for]).json()["drafts"]
    name = waits_for[2:]
    assert kept["source"]["conversation"] == (chats.get(name) if name in chats and steps[-1] not in ("hive", "mind") else None), kept


def test_an_ask_turns_draft_waits_for_the_person_who_asked(client):
    from hive.tests.test_ask import ask, reply, world
    w = world(client)
    turn = ask(client, w["ann"], "op-draft-0001", context={"swarm_id": w["swarm"]["id"]}).json()["turn_id"]
    reply(w["hive"], w["coord"], turn)
    r = client.post("/api/feedback/drafts", headers=agent_headers(w["coord"]), json=dict(DRAFT, conversation=f"ask:{turn}"))
    assert r.status_code == 201 and r.json()["for"] == "user:u_ann", r.text
    # naming none, the turn it just answered is the conversation it came up in
    unnamed = client.post("/api/feedback/drafts", headers=agent_headers(w["coord"]), json=dict(DRAFT, title="The Ask lost my words"))
    assert unnamed.status_code == 201 and unnamed.json()["for"] == "user:u_ann", unnamed.text
    # another mind of the swarm that never spoke in that turn cannot name it
    other = client.post("/api/feedback/drafts", headers=agent_headers(w["worker"]), json=dict(DRAFT, conversation=f"ask:{turn}"))
    assert other.status_code == 400 and other.json()["error"]["code"] == "bad_draft", other.text


@pytest.mark.parametrize("case", ["never spoke", "only the mind wrote there", "another mind's chat", "unknown ask turn", "a room"])
def test_a_conversation_that_is_not_one_persons_with_this_mind_is_refused(client, case):
    """No draft lands with someone this mind never heard from, even in a conversation the mind wrote into itself (Jon on
    #366: a mind picks any conversation id it sends to), nor with one person of many."""
    ana, _, mind = setting(client)
    bob = person(client, "u_bob")
    if case == "never spoke":
        conversation = f"c_{mind['id']}~user:u_ben"
    elif case == "only the mind wrote there":
        conversation = f"c_{mind['id']}~user:u_ben"
        answers(client, mind, conversation)
    elif case == "another mind's chat":
        other = client.post("/api/agents", json={"name": "Lyra", "kind": "module"}).json()
        client.put(f"/api/agents/{other['id']}/visibility", json={"visibility": "public"})
        assert client.post(f"/api/agents/{other['id']}/messages", headers=bob, json={"text": "hello"}).status_code == 200
        conversation = f"c_{other['id']}~user:u_bob"
    elif case == "unknown ask turn":
        conversation = "ask:t_0000000000000000"
    else:
        room = client.post("/api/rooms", json={"kind": "group", "name": "G", "members": [f"agent:{mind['id']}"]}).json()
        said = client.post(f"/api/agents/{mind['id']}/messages", json={"text": "hello, room", "conversation_id": room["id"]})
        assert said.status_code == 200, said.text
        conversation = room["id"]
    r = client.post("/api/feedback/drafts", headers=agent_headers(mind), json=dict(DRAFT, conversation=conversation))
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_draft", r.text
    assert "not one of this mind's conversations with one person" in r.json()["error"]["message"]
    for who in (ana, bob):
        assert client.get("/api/feedback/drafts", headers=who).json() == {"drafts": []}


def test_drafting_sends_nothing_anywhere(client, monkeypatch):
    """The person's yes in the area is what sends a report: a draft never reaches the report service."""
    hive = client.app.state.hive
    monkeypatch.setattr(hive.feedback, "send", lambda report: pytest.fail("a draft must never be sent"))
    _, _, mind = setting(client)
    assert client.post("/api/feedback/drafts", headers=agent_headers(mind), json=DRAFT).status_code == 201


def test_the_skill_is_declared_reviewed_and_allowed_by_default(client):
    for path, needle in ((ROOT / "modules/hive/signatures.metta", "(SkillSignature hive-report-problem (Arg rest-text json))"),
                         (ROOT / "modules/hive/skills.metta", "(py-call (hive_commons.report_problem $json))"),
                         (ROOT / "modules/hive/entry.metta", "(Provides omegaclaw.hive.commons (Skill hive-report-problem))"),
                         (ROOT / "modules/hive/module.toml", '"skill:hive-report-problem"'),
                         (ROOT / "modules/hive/catalog.metta", '(SkillHelp "hive-report-problem"')):
        assert needle in path.read_text(encoding="utf-8"), path
    assert "hive-report-problem" in REVIEWED_HIVE_SKILLS and "report_problem" in hc.SKILLS
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "P"}).json()
    mind = hive.create_agent("M", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert hive.policy.decide(mind, "hive-report-problem")[0] == "allow"


def test_the_skill_posts_as_the_mind_and_says_where_the_draft_waits(monkeypatch):
    calls = []

    def call(method, path, payload=None):
        calls.append((method, path, payload))
        return {"id": "fd-1a2b3c4d", "for": "user:u_ana"}, None
    monkeypatch.setattr(hc, "_call", call)
    out = hc.report_problem(json.dumps(DRAFT))
    assert calls == [("POST", "/api/feedback/drafts", DRAFT)]
    assert out == "HIVE-REPORT-DRAFT fd-1a2b3c4d waits in user:u_ana's feedback area. Nothing is sent until they say yes there."
    bad = hc.report_problem('{"kind": "bug", "title": ')
    assert bad.startswith("HIVE-ERROR bad_request: give a JSON object") and '"words"' in bad and len(calls) == 1
    monkeypatch.setattr(hc, "_call", lambda *a, **k: (None, "HIVE-ERROR bad_draft: title is required"))
    assert hc.report_problem(json.dumps(dict(DRAFT, title=""))) == "HIVE-ERROR bad_draft: title is required"
