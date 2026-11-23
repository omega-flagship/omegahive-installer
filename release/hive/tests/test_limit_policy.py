"""Purpose: check the limit law (lib_limits.metta), who may set or remove each spending limit, on the hive's pinned
PeTTa, and the bridge that asks it (limit_policy.py)."""

import os
import re
from itertools import product
from pathlib import Path

import pytest

from hive.core.limit_policy import HIVE, NO_TARGET, Asker, LimitPolicy, Target
from hive.core.limits_view import REFUSALS
from hive.spaces.service import LIB_LIMITS, SpaceError, SpaceService

CAPS = ("agent", "swarm")                              # a cap on a mind or a swarm
OTHERS = ("hive", "every-mind", "person", "key")       # the hive cap, an allowance, the every-mind rule, a key's limit


@pytest.fixture(scope="module")
def policy(tmp_path_factory):
    petta = Path(os.environ.get("PETTA_PATH", Path.home() / "PeTTa"))
    if not (petta / "src" / "main.pl").is_file():
        pytest.skip("needs PeTTa")
    return LimitPolicy(SpaceService(tmp_path_factory.mktemp("limits"), petta_path=str(petta)).run)


def person(principal, admin=False):
    return Asker("person", principal, admin)


ANN = person("user:u_ann")


def test_the_law_decides_every_limit_by_its_rule(policy):
    """Every kind of limit, for every target the host can describe and every asker, against the rule as Jon gave it (on
    #615, 21 Nov: "No admin controls another user"; on #256, 23 Nov: a cap on a mind is set only by that mind's owner):
    a cap is its own person's, its owner's or the one it is the personal mind or swarm of, an admin's only where it
    records neither; one the asker can't see is not found; every other limit is an admin's; the hive itself may change
    any limit it knows."""
    people = ("user:u_ann", "user:u_bob", "user:u_jon")
    targets = [Target(seen, owner, personal) for seen, owner, personal in product((True, False), people + (None,),
                                                                                 people + (None,))]
    askers = [person(p, admin) for p, admin in product(people, (False, True))] + [HIVE]
    for limit, asker in product(CAPS + OTHERS + ("team",), askers):
        for target in targets if limit in CAPS else [NO_TARGET]:
            if limit == "team":
                expected = ("Refused", "unknown-limit")
            elif asker == HIVE:
                expected = ("Granted",)
            elif limit in OTHERS:
                expected = ("Granted",) if asker.admin else ("Refused", "admin-only")
            elif not target.seen:
                expected = ("Refused", "not-found")
            else:
                recorded = {target.owner, target.personal_of} - {None}
                own = asker.id in recorded if recorded else asker.admin
                expected = ("Granted",) if own else ("Refused", "owner-only")
            assert policy.may(limit, target, asker) == expected, (limit, target, asker)


def test_anyone_the_host_cannot_name_is_refused(policy):
    for asker in (person(""), person(None, True), Asker("mind", "agent:a_00000001", True),
                  Asker("person (x)", "user:u_ann", True)):     # not a word: it travels as ""
        for limit, target in (("hive", NO_TARGET), ("agent", Target(True))):
            assert policy.may(limit, target, asker) == ("Refused", "invalid-asker"), asker
    assert policy.may("agent extra", Target(True), person("user:u_jon", True)) == ("Refused", "unknown-limit")


def test_identities_stay_exact_across_the_bridge(policy):
    owner = 'user:å "(someone)" \\'
    target = Target(True, owner)
    assert policy.may("agent", target, person(owner)) == ("Granted",)
    for other in (owner + "\n", owner.upper(), owner[:-1]):
        assert policy.may("agent", target, person(other)) == ("Refused", "owner-only")


def test_each_question_is_asked_once_in_the_laws_own_terms():
    asked = []

    def run(query):
        asked.append(query)
        return ["(Granted)"]

    policy = LimitPolicy(run)
    for _ in range(3):
        assert policy.may("agent", Target(True, "user:u_ann"), ANN) == ("Granted",)
    policy.may("agent", Target(True, "user:u_ann"), person("user:u_bob"))
    ann = "user:u_ann".encode().hex()
    assert asked[0] == f'!(limit-decide "agent" (Target True "{ann}" "") (By "person" "{ann}" False))'
    assert len(asked) == 2


def test_the_bridge_keeps_the_laws_refusal_word():
    policy = LimitPolicy(lambda _query: ["(Refused term-from-the-law)"])
    assert policy.may("hive", NO_TARGET, ANN) == ("Refused", "term-from-the-law")


@pytest.mark.parametrize("results", [
    [], ["(Refused withheld)", "(Granted)"], ["(Granted extra)"], ['("Granted")'], ["(Granted) trailing"],
    ["(Granted"], ["(Refused)"], ["(Refused (nested))"], ['(Refused "quoted")'],
    ['(limit-decide "agent" (Target True "" "") (By "person" "" False))'],   # a call no rule of the law reduces
])
def test_the_bridge_refuses_malformed_or_ambiguous_verdicts(results):
    with pytest.raises(SpaceError, match="exactly one"):
        LimitPolicy(lambda _query: results).may("agent", Target(True), ANN)


def test_every_refusal_the_law_can_give_has_a_route_answer():
    code = "\n".join(line.split(";", 1)[0] for line in LIB_LIMITS.read_text(encoding="utf-8").splitlines())
    assert set(re.findall(r"\(Refused ([^\s()]+)\)", code)) == set(REFUSALS)
