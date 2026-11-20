# Purpose: test that a mind's hive-create call is only an offer to its person: kept for them, started in Create by their
# own press (once, with the offer's words, behind Create's person gate) or set aside, and offered to the right person.
"""Create offers (Jon, 17 Nov 09:03: route the minds' coding only through Create).

A scripted plan engine: start() records the person and sentence it is given, so nothing is planned or built.
"""
import pytest

from hive.core.create_offers import OFFERED_NEXT
from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

ORIGIN = {"Origin": "http://127.0.0.1:8700"}
SENTENCE = "a tic tac toe game with a restart button"


@pytest.fixture()
def world(client):  # noqa: F811
    hive = client.app.state.hive
    hive.settings.create_plan_engine = True
    for pid, name in (("u_jon", "Jon"), ("u_ann", "Ann")):
        hive.db.insert("people", {"id": pid, "email": f"{pid}@example.test", "name": name, "role": "member",
                                  "created_at": now()})
        hive.db.insert("sessions", {"token_hash": token_hash(f"{pid}-session"), "created_at": now(), "kind": "sso",
                                    "principal": f"user:{pid}"})
    started = []

    async def start(principal, sentence):
        started.append((principal, sentence))
        return {"plan_id": f"plan_{len(started)}", "sentence": sentence, "status": "planning"}
    hive.create_plans.start = start
    hive.create_plans.view = lambda pid: {"plan_id": pid, "status": "planning"}
    events = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **kw: (events.append((kind, kw)), real(kind, **kw))[1]
    _, (mind,) = make_swarm_and_agents(client, n=1)
    w = type("W", (), {})()
    w.client, w.hive, w.mind, w.started, w.events = client, hive, mind, started, events
    w.jon = {"Authorization": "Bearer u_jon-session", **ORIGIN}
    w.ann = {"Authorization": "Bearer u_ann-session", **ORIGIN}
    return w


def _own(w, person="user:u_jon"):
    w.hive.db.execute("UPDATE agents SET personal_of = ? WHERE id = ?", (person, w.mind["id"]))


def _offer(w, **extra):
    return w.client.post("/api/agent/create", json={"sentence": SENTENCE, **extra}, headers=agent_headers(w.mind))


def test_a_minds_build_request_is_offered_to_its_person_and_nothing_is_built(world):
    w = world
    _own(w)
    r = _offer(w)
    assert r.status_code == 201 and r.json()["state"] == "offered" and r.json()["id"].startswith("cof_")
    assert r.json()["next"] == OFFERED_NEXT   # the mind is told it waits for the person's Start, and where
    listed = w.client.get("/api/me/create-offers", headers=w.jon).json()
    assert [(o["id"], o["sentence"], o["mind"]["id"]) for o in listed] == [(r.json()["id"], SENTENCE, w.mind["id"])]
    assert "next" not in listed[0]   # the person's list is the offers alone
    assert w.client.get(f"/api/me/create-offers?mind={w.mind['id']}", headers=w.jon).json() == listed
    assert w.client.get("/api/me/create-offers", headers=w.ann).json() == []   # nobody else's
    assert w.started == []   # an offer builds nothing
    assert ("create.offer", {"principal": "user:u_jon", "offer_id": r.json()["id"], "agent_id": w.mind["id"],
                             "state": "offered"}) in w.events


def test_the_same_call_again_answers_the_same_offer(world):
    w = world
    _own(w)
    first, again = _offer(w), _offer(w)
    assert (first.status_code, again.status_code) == (201, 200) and again.json()["id"] == first.json()["id"]
    assert again.json()["next"] == first.json()["next"] == OFFERED_NEXT
    assert len(w.client.get("/api/me/create-offers", headers=w.jon).json()) == 1


def test_the_persons_press_starts_the_plan_with_the_offers_words_once(world):
    w = world
    _own(w)
    offer = _offer(w).json()
    pressed = w.client.post(f"/api/create/offers/{offer['id']}/start", headers=w.jon)
    assert pressed.status_code == 200 and pressed.json()["plan"]["plan_id"] == "plan_1"
    assert pressed.json()["offer"]["state"] == "started" and pressed.json()["offer"]["plan_id"] == "plan_1"
    assert w.started == [("user:u_jon", SENTENCE)]   # exactly as if Jon had typed it into Create
    again = w.client.post(f"/api/create/offers/{offer['id']}/start", headers=w.jon)
    assert again.status_code == 200 and again.json()["plan"]["plan_id"] == "plan_1" and len(w.started) == 1
    assert w.client.get("/api/me/create-offers", headers=w.jon).json() == []   # no longer open


def test_only_its_person_in_their_own_session_starts_it(world):
    w = world
    _own(w)
    offer = _offer(w).json()
    path = f"/api/create/offers/{offer['id']}/start"
    assert w.client.post(path, headers={"Authorization": "Bearer u_jon-session"}).status_code == 403   # no Origin
    assert w.client.post(path, headers=ORIGIN).status_code in (401, 403)   # the operator password is no person
    assert w.client.post(path, headers={**agent_headers(w.mind), **ORIGIN}).status_code in (401, 403)   # never a mind
    assert w.client.post(path, headers=w.ann).status_code == 404   # someone else's offer is no offer
    assert w.started == []


def test_not_now_sets_it_aside(world):
    w = world
    _own(w)
    offer = _offer(w).json()
    r = w.client.post(f"/api/create/offers/{offer['id']}/dismiss", headers=w.jon)
    assert r.status_code == 200 and r.json()["state"] == "dismissed"
    assert w.client.get("/api/me/create-offers", headers=w.jon).json() == []
    closed = w.client.post(f"/api/create/offers/{offer['id']}/start", headers=w.jon)
    assert closed.status_code == 409 and closed.json()["error"]["code"] == "offer_closed" and w.started == []
    assert _offer(w).status_code == 201   # asked again, it is a new offer


def test_an_offer_goes_to_the_person_the_mind_is_answering(world):
    w = world
    hive, mind = w.hive, w.mind
    hive.enqueue_message(mind["id"], "make me a game", "c_room_1", "user:u_ann")
    hive.enqueue_message(mind["id"], "hello", None, "user:u_jon")
    # the conversation named: its last person (Ann there, though Jon wrote to the mind since)
    assert _offer(w, conversation_id="c_room_1").status_code == 201
    assert len(w.client.get("/api/me/create-offers", headers=w.ann).json()) == 1
    # none named, on nobody's own mind: whoever wrote to it last
    assert w.client.post("/api/agent/create", json={"sentence": "a todo list"}, headers=agent_headers(mind)).status_code == 201
    assert [o["sentence"] for o in w.client.get("/api/me/create-offers", headers=w.jon).json()] == ["a todo list"]


def test_an_offer_naming_no_conversation_goes_to_whoever_wrote_last_before_the_minds_own_person(world):
    # Jon on #395: an offer with no conversation goes to the last person who wrote, not the owner. A mind names none when
    # it answers nobody, or when two conversations or more wait on it (hive_channel.reply_conversation)
    w = world
    _own(w)   # Jon's own mind, and nobody has written to it yet: Jon's offer
    assert _offer(w).status_code == 201
    assert len(w.client.get("/api/me/create-offers", headers=w.jon).json()) == 1
    w.hive.enqueue_message(w.mind["id"], "make me a game", "c_room_1", "user:u_ann")
    assert w.client.post("/api/agent/create", json={"sentence": "a game"}, headers=agent_headers(w.mind)).status_code == 201
    assert [o["sentence"] for o in w.client.get("/api/me/create-offers", headers=w.ann).json()] == ["a game"]
    assert [o["sentence"] for o in w.client.get("/api/me/create-offers", headers=w.jon).json()] == [SENTENCE]


def test_an_offer_from_a_mind_answering_an_ask_turn_goes_to_its_asker(world):
    w = world
    hive, mind = w.hive, w.mind
    hive.db.insert("ask_turns", {"id": "at_1", "operation_id": "op-1", "principal": "user:u_ann", "body_digest": "d",
                                 "thread_id": "se_1", "mind_id": mind["id"], "swarm_id": mind["swarm_id"], "text": "",
                                 "via": "typed", "context_resolved": "{}", "state": "accepted", "reason": None,
                                 "room_message_id": "", "delivery_message_id": "", "answer_message_id": None,
                                 "deadline": 0.0, "mind_spent_at_start": 0.0, "next_seq": 1, "created_at": now(),
                                 "closed_at": None, "spent_usd_approx": None, "deleted_at": None})
    _own(w)   # Jon's own mind, but answering Ann's Ask turn: Ann's offer
    assert _offer(w, conversation_id="ask:at_1").status_code == 201
    assert len(w.client.get("/api/me/create-offers", headers=w.ann).json()) == 1
    assert w.client.get("/api/me/create-offers", headers=w.jon).json() == []


def test_a_mind_with_no_person_has_nobody_to_offer_to(world):
    r = _offer(world)
    assert r.status_code == 403 and r.json()["error"]["code"] == "person_required"


@pytest.mark.parametrize("sentence", ["", "   ", "x" * 2001])
def test_an_offer_says_what_to_build_within_create_limits(world, sentence):
    _own(world)
    r = world.client.post("/api/agent/create", json={"sentence": sentence}, headers=agent_headers(world.mind))
    assert r.status_code == 400


def test_with_create_off_there_is_nowhere_to_build(world):
    _own(world)
    world.hive.settings.create_plan_engine = False
    r = _offer(world)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_available"


def test_the_offer_event_reaches_only_its_person(world):
    import json
    from hive.core.visibility import Viewer
    text = json.dumps({"type": "create.offer", "principal": "user:u_jon", "offer_id": "cof_1", "agent_id": "a",
                       "state": "offered"})
    seen = world.hive.visibility.event_visible
    assert seen(Viewer("user:u_jon", False), text) and not seen(Viewer("user:u_ann", False), text)
    assert not seen(Viewer("user:operator", True), text)   # an admin is not sent another person's offer
