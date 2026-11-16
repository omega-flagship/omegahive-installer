"""Purpose: a swarm's view integrates a statement's sources, the commons' Current and each linked mind's held belief, by
lib_hive's own rule at read time. A belief one mind holds after reading another's carries the stamp it read, so it
leaves the swarm's confidence unchanged; two minds' independent beliefs revise it. The view also keeps out the four
ways shared memory fails (unauthorized leakage, stale propagation, contradiction persistence, provenance collapse)."""

import itertools
import os
import random
import secrets
from pathlib import Path

import pytest

from hive.spaces.service import SpaceService

PETTA = os.environ.get("PETTA_PATH", str(Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
SKY = "(--> (x sky blue) color)"
TEA = '(--> (x user "green tea") likes)'
FREQUENCIES, CONFIDENCES = (0.0, 0.1, 0.5, 0.9, 1.0), (0.1, 0.3, 0.5, 0.8, 0.9)
TVS = list(itertools.product(FREQUENCIES, CONFIDENCES))   # 25 truth values
CASES = 60   # random cases for each test whose space is too large to run whole


@pytest.fixture(scope="module")
def spaces(tmp_path_factory):
    return SpaceService(tmp_path_factory.mktemp("belief-view"), petta_path=PETTA)


def team(spaces, n, link=("$stmt",)):
    """A fresh swarm with n linked member minds, ids in order."""
    swarm, minds = "s_" + secrets.token_hex(6), [f"a_{i}{secrets.token_hex(5)}" for i in range(n)]
    minds.sort()
    for mind in minds:
        spaces.grant(mind, swarm)
        spaces.link(mind, swarm, list(link))
    return swarm, minds


def view_of(spaces, swarm, statement, reader=None):
    found = spaces.belief(swarm, statement, reader)
    return None if found is None else (found["tv"], found["stamp"])


def test_the_view_is_what_the_commons_would_hold_had_the_minds_published_in_order(spaces):
    """The oracle is the commons itself: every source published in the view's order, the first mind's, then each
    other mind's, by hive-publish!, gives the same Current as the read-time view."""
    rng = random.Random(354)
    for _ in range(CASES):
        first = rng.choice(TVS)
        others = [(rng.choice(TVS), rng.choice(["own", "echo"])) for _ in range(rng.randint(1, 4))]
        assert_view_is_the_commons_order(spaces, first, others)


def assert_view_is_the_commons_order(spaces, first, others):
    swarm, minds = team(spaces, 1 + len(others))
    oracle = "s_" + secrets.token_hex(6)
    sources = [(minds[0], first, [f"ev:{minds[0]}:1"])]
    for mind, (tv, kind) in zip(minds[1:], others):
        sources.append((mind, tv, sources[0][2] if kind == "echo" else [f"ev:{mind}:1"]))
    for mind, (f, c), stamp in sources:
        spaces.mount_beliefs(mind, [(SKY, f, c, stamp)])
        spaces.grant(mind, oracle)
        spaces.publish(oracle, mind, SKY, f, c, stamp)
    assert view_of(spaces, swarm, SKY) == view_of(spaces, oracle, SKY), (first, others)


def test_a_belief_one_mind_repeats_after_reading_another_leaves_the_swarms_confidence_unchanged(spaces):
    for tv in TVS:   # every truth value
        swarm, (a, b) = team(spaces, 2)
        spaces.mount_beliefs(a, [(SKY, *tv, [f"ev:{a}:1"])])
        before = view_of(spaces, swarm, SKY)
        spaces.mount_beliefs(b, [(SKY, *tv, [f"ev:{a}:1"])])   # b holds what it read, on the stamp it read
        assert view_of(spaces, swarm, SKY) == before == ({"f": tv[0], "c": tv[1]}, [f"ev:{a}:1"]), tv


def test_two_minds_independent_beliefs_revise_it(spaces):
    rng = random.Random(355)
    for one, two in (rng.sample(TVS, 1) + rng.sample(TVS, 1) for _ in range(CASES)):
        swarm, (a, b) = team(spaces, 2)
        spaces.mount_beliefs(a, [(SKY, *one, [f"ev:{a}:1"])])
        spaces.mount_beliefs(b, [(SKY, *two, [f"ev:{b}:1"])])
        tv, stamp = view_of(spaces, swarm, SKY)
        assert stamp == sorted([f"ev:{a}:1", f"ev:{b}:1"]), (one, two)
        assert tv["c"] > max(one[1], two[1]) or tv["c"] == 0.99, (one, two, tv)


def test_an_echo_of_a_revised_belief_never_keeps_its_sources_from_revising(spaces):
    """A mind that read the swarm's revised belief holds the merged stamp; the fold takes evidence before what was
    formed from it, so even when the echo's mind comes first by id, the sources revise and the echo is a choice."""
    rng = random.Random(356)
    for _ in range(CASES):
        one, two, echo = rng.choice(TVS), rng.choice(TVS), rng.choice(TVS)
        swarm, (e, a, b) = team(spaces, 3)   # e has the smallest id
        spaces.mount_beliefs(a, [(SKY, *one, [f"ev:{a}:1"])])
        spaces.mount_beliefs(b, [(SKY, *two, [f"ev:{b}:1"])])
        revised = view_of(spaces, swarm, SKY)
        spaces.mount_beliefs(e, [(SKY, *echo, sorted([f"ev:{a}:1", f"ev:{b}:1"]))])
        tv, stamp = view_of(spaces, swarm, SKY)
        assert stamp == revised[1] and tv["c"] == max(revised[0]["c"], echo[1]), (one, two, echo, tv)


def test_a_mind_of_another_swarm_and_a_statement_outside_the_link_see_nothing(spaces):
    """Unauthorized leakage: the link admits the swarm's members, for the statements its pattern matches."""
    swarm, (a, b) = team(spaces, 2)
    spaces.link(b, swarm, ["(--> (x sky $value) $relation)"])
    other, (c,) = team(spaces, 1)
    spaces.mount_beliefs(a, [(SKY, 1.0, 0.9, [f"ev:{a}:1"]), (TEA, 0.9, 0.8, [f"ev:{a}:2"])])
    spaces.mount_beliefs(b, [(TEA, 1.0, 0.9, [f"ev:{b}:1"])])
    assert [x["statement"] for x in spaces.beliefs(swarm)] == sorted([SKY, TEA])
    assert spaces.belief(swarm, TEA)["holders"] == [a]              # b's tea belief is outside b's link
    assert spaces.beliefs(swarm, c) == [] and spaces.query(swarm, "(Held $m $s $t $st)", c) == []
    assert spaces.count(other) == 0
    spaces.link(a, swarm, [])
    assert spaces.beliefs(swarm) == []


def test_a_belief_its_mind_drops_or_changes_reads_as_the_mind_holds_it_now(spaces):
    """Stale propagation and contradiction persistence: the view reads each mind's last save, never a copy."""
    swarm, (a,) = team(spaces, 1)
    spaces.mount_beliefs(a, [(SKY, 1.0, 0.9, [f"ev:{a}:1"])])
    spaces.mount_beliefs(a, [(SKY, 0.0, 0.9, [f"ev:{a}:1"])])
    assert view_of(spaces, swarm, SKY) == ({"f": 0.0, "c": 0.9}, [f"ev:{a}:1"])
    spaces.mount_beliefs(a, [])
    assert view_of(spaces, swarm, SKY) is None and spaces.count(swarm) == 0


def test_each_belief_names_the_minds_holding_it_and_an_echo_keeps_its_source(spaces):
    """Provenance collapse: holders are the minds whose space holds the statement; an echo's stamp stays its source's."""
    swarm, (a, b, c) = team(spaces, 3)
    spaces.mount_beliefs(a, [(SKY, 1.0, 0.8, [f"ev:{a}:1"])])
    spaces.mount_beliefs(b, [(SKY, 1.0, 0.8, [f"ev:{a}:1"])])
    found = spaces.belief(swarm, SKY)
    assert found["holders"] == sorted([a, b]) and found["stamp"] == [f"ev:{a}:1"]
    assert {h["mind"]: h["stamp"] for h in found["held"]} == {a: [f"ev:{a}:1"], b: [f"ev:{a}:1"]}
    assert spaces.query(swarm, f"(Held $m {SKY} $t $st)", c) == [
        f"(Held {m} {SKY} (stv 1.0 0.8) ((ev {a} 1)))" for m in sorted([a, b])]


def test_a_mind_leaving_takes_its_link_and_compaction_keeps_none(spaces):
    swarm, (a, b) = team(spaces, 2)
    spaces.mount_beliefs(a, [(SKY, 1.0, 0.9, [f"ev:{a}:1"])])
    assert len(spaces.links(a, swarm)) == 1
    spaces.revoke(a, swarm)
    assert spaces.links(a, swarm) == [] and spaces.beliefs(swarm) == []
    spaces.compact()   # read grants are derived: compaction skips them instead of refusing the access list
