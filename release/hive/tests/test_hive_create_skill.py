"""Purpose: test hive-create, the way a mind builds software unless its owner switched its own coding on (Jon in the
testers' group, 17 Nov: "Route them only through create"): every mind may use it without asking, its words reach the
hive's create route as one sentence with the conversation the mind is answering, an Omega mind and an Iter mind both
make the offer, and the mind reads what happened, the hive's refusal included."""
import importlib.util
import pathlib
import sys

import pytest

from hive.core.create_offers import OFFERED_NEXT
from hive.core import policy
from hive.runtime.extensions import helper_command_parser as parser
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (client: fixture)
from hive.tests.test_create_offers import SENTENCE, _own, world  # noqa: F401  (world: fixture)
from hive.tests.test_phase2_api import authorize

ROOT = pathlib.Path(__file__).resolve().parents[2]
OFFER = {"id": "cof_" + "a1" * 12, "state": "offered", "next": OFFERED_NEXT}
ANSWER = f"HIVE-CREATE-OFFERED {OFFER['id']}: {OFFERED_NEXT}"


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def recording(sent, answer=(OFFER, None)):
    def call(method, path, payload=None, timeout=None):
        sent.append((method, path, payload))
        return answer
    return call


def test_every_mind_may_ask_create_without_asking_a_person(client):
    hive = client.app.state.hive
    _, (a, _) = make_swarm_and_agents(client)
    assert "hive-create" in policy.REVIEWED_HIVE_SKILLS
    assert hive.policy.decide(hive.agent(a["id"]), "hive-create")[0] == "allow"
    assert authorize(client, a, f'(hive-create "{SENTENCE}")')["decision"] == "allow"


def test_the_minds_own_gate_lets_hive_create_through_without_a_round_trip(monkeypatch):
    commons = load("modules/hive/src/hive_commons.py", "hive_commons_create_gate")
    monkeypatch.setattr(commons, "_call", lambda *a: pytest.fail(f"the gate asked the hive: {a}"))
    assert commons.authorize(f'(hive-create "{SENTENCE}")') is True


def test_what_to_build_is_one_sentence_however_the_mind_lays_it_out():
    parser.reload_signature_commands(ROOT / "modules" / "hive" / "signatures.metta")
    try:
        assert parser.signature_balance_parentheses("hive-create a tip calculator\nthat splits the bill") == \
            '((hive-create "a tip calculator that splits the bill"))'
    finally:
        parser.reload_signature_commands()


@pytest.mark.parametrize("waiting,current,conversation", [
    (["c_m~user:u_1"], "", "c_m~user:u_1"),           # the one person waiting for an answer gets the offer
    ([], "c_m~user:u_2", "c_m~user:u_2"),            # none waiting: the conversation the mind last spoke in
    (["c_m~user:u_1", "c_m~user:u_3"], "", None),    # several waiting: the hive picks the person
    ([], "", None),
])
def test_an_omega_mind_offers_it_to_the_person_a_plain_send_would_answer(monkeypatch, waiting, current, conversation):
    commons = load("modules/hive/src/hive_commons.py", "hive_commons_create")
    channel = load("modules/channel_hive/src/hive_channel.py", "hive_channel")
    monkeypatch.setitem(sys.modules, "hive_channel", channel)
    monkeypatch.setattr(channel, "_pending", list(waiting))
    monkeypatch.setattr(channel, "_current", current)
    sent = []
    monkeypatch.setattr(commons, "_call", recording(sent))
    assert commons.create(f'"{SENTENCE}"') == ANSWER
    payload = {"sentence": SENTENCE} | ({"conversation_id": conversation} if conversation else {})
    assert sent == [("POST", "/api/agent/create", payload)]


@pytest.mark.parametrize("latest", ["c_m~user:u_1", ""])
def test_an_iter_mind_offers_it_to_the_conversation_send_answers(monkeypatch, tmp_path, latest):
    monkeypatch.chdir(tmp_path)      # an Iter worker runs in its own folder, where the channel keeps the latest one
    if latest:
        (tmp_path / ".hive_conversation").write_text(latest + "\n")
    tool = load("hive/templates/iter/tools/hive_create.py", "iter_hive_create")
    sent = []
    monkeypatch.setattr(tool._hive, "call", recording(sent))
    assert tool.run(f"  {SENTENCE}  ") == ANSWER
    payload = {"sentence": SENTENCE} | ({"conversation_id": latest} if latest else {})
    assert sent == [("POST", "/api/agent/create", payload)]


def test_the_hives_refusal_reaches_the_mind_as_it_is(monkeypatch):
    commons = load("modules/hive/src/hive_commons.py", "hive_commons_create_refused")
    refusal = "HIVE-ERROR person_required: there is nobody to offer this build to"
    monkeypatch.setattr(commons, "_call", recording([], (None, refusal)))
    assert commons.create(SENTENCE) == refusal


def test_a_minds_hive_create_puts_an_offer_in_front_of_its_person(world, monkeypatch):  # noqa: F811
    """Through the real route: what the mind writes is offered to its person, and nothing is started."""
    _own(world)
    commons = load("modules/hive/src/hive_commons.py", "hive_commons_create_route")

    def through_the_hive(method, path, payload=None):
        r = world.client.request(method, path, json=payload, headers=agent_headers(world.mind))
        return (r.json(), None) if r.status_code < 300 else (None, f"HIVE-ERROR {r.json()['error']['code']}")
    monkeypatch.setattr(commons, "_call", through_the_hive)
    answer = commons.create(SENTENCE)
    offers = world.client.get("/api/me/create-offers", headers=world.jon).json()
    assert [(o["sentence"], o["mind"]["id"], o["state"]) for o in offers] == [(SENTENCE, world.mind["id"], "offered")]
    assert answer == f"HIVE-CREATE-OFFERED {offers[0]['id']}: {OFFERED_NEXT}" and world.started == []


def test_the_mind_is_told_nothing_is_built_before_the_start_and_where_the_card_is():
    """A tester's mind said it "built the blue tip calculator" after the softer "your person can start it in Create
    from your chat": the line now opens with not built, names where the card is and rules out calling it built."""
    assert OFFERED_NEXT.startswith("offered, not built. Nothing is built until your person presses Start in Create")
    for words in ("on the offer card", "in their Ask", "in your chat with them", "never say it is built or being built"):
        assert words in OFFERED_NEXT
