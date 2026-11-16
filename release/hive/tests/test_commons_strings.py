"""Purpose: a string inside a commons statement or pattern either crosses into the hive's PeTTa and reads back as the
same statement, or is refused before it gets there; it never stops the commons. PeTTa's reader ends a string at any
double quote, so one mind's hive-publish of (--> "a\\"b" c) used to stop every commons write until a restart."""

import os
import random
import string
from pathlib import Path

import pytest

from hive.spaces import sexpr
from hive.spaces.service import SpaceService
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401

PETTA = os.environ.get("PETTA_PATH", str(Path.home() / "PeTTa"))
needs_petta = pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def test_a_string_holding_a_double_quote_is_refused_by_every_parse():
    for text in ('(--> "a\\"b" c)', '(--> "\\"" c)', '(--> c "say \\"hi\\"")'):
        with pytest.raises(sexpr.SexprError, match="double quote"):
            sexpr.safe_statement(text)
        with pytest.raises(sexpr.SexprError, match="double quote"):
            sexpr.safe_commons_statement(text)
        with pytest.raises(sexpr.SexprError, match="double quote"):
            sexpr.safe_pattern(text.replace("c)", "$x)"))
    assert sexpr.safe_commons_statement('(--> "a\\\\b" c)') == '(--> "a\\\\b" c)'   # a backslash crosses as it is


def test_a_string_holding_a_parenthesis_stays_a_string():
    assert sexpr.parse('(--> "(" ")")') == ["-->", sexpr.Str("("), sexpr.Str(")")]
    assert sexpr.read_result('(--> "(" ")")') == ["-->", sexpr.Str("("), sexpr.Str(")")]
    assert sexpr.safe_commons_statement('(--> "(" thing)') == '(--> "(" thing)'


@needs_petta
def test_a_publish_or_query_holding_a_double_quote_is_refused_and_the_commons_keeps_writing(client):
    swarm, (agent,) = make_swarm_and_agents(client, n=1)
    headers = agent_headers(agent)
    refused = client.post("/api/agent/publish", headers=headers, json={"statement": '(--> "a\\"b" c)', "f": .9, "c": .8})
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "bad_statement"
    asked = client.post("/api/agent/query", headers=headers, json={"pattern": '(Current (--> "x\\"y" $z) $t $s)'})
    assert asked.status_code == 400 and asked.json()["error"]["code"] == "bad_pattern"
    after = client.post("/api/agent/publish", headers=headers, json={"statement": "(--> sky blue)", "f": .9, "c": .8})
    assert after.status_code == 200 and after.json()["outcome"] == "adopted"


@pytest.fixture(scope="module")
def spaces(tmp_path_factory):
    return SpaceService(tmp_path_factory.mktemp("commons-strings"), petta_path=PETTA)


# Characters a string most plausibly breaks on: the reader's delimiters and escapes, whitespace and controls, and
# unicode that changes width, direction or normal form.
EDGES = '"\\()$;\' \t\n\r\x00\x01\x1b\x1f\x7f`,{}[]#|' + "\u00e9\u4e2d\U0001f642\u2028\u00a0\ufeff\u0301\U0010ffff"


def random_char(rng, without=""):
    """An edge character, an ASCII letter or digit, or any code point but a surrogate, a third of the time each, and
    never one in without."""
    while True:
        pick = rng.random()
        if pick < 1 / 3:
            char = rng.choice(EDGES)
        elif pick < 2 / 3:
            char = rng.choice(string.ascii_letters + string.digits)
        else:
            code = rng.randrange(0x110000 - 0x800)   # every code point but the 2048 surrogates, which UTF-8 can't hold
            char = chr(code if code < 0xD800 else code + 0x800)
        if char not in without:
            return char


def random_text(rng, longest, without=""):
    """0 to longest characters from random_char."""
    return "".join(random_char(rng, without) for _ in range(rng.randint(0, longest)))


def random_texts(seed, count, longest=12, without=""):
    """count texts of 0 to longest characters, the same ones for the same seed."""
    rng = random.Random(seed)
    return [random_text(rng, longest, without) for _ in range(count)]


def _crosses(spaces, text):
    """(--> "<text>" thing) is published and reads back as itself, unless text holds a double quote and is refused."""
    statement = sexpr.render(["-->", sexpr.Str(text), "thing"])
    try:
        canonical = sexpr.safe_commons_statement(statement)
    except sexpr.SexprError:
        assert '"' in text, f"refused {text!r}"   # the one character a string can't carry into PeTTa
        return
    assert canonical == statement, f"{text!r} became {canonical!r}"
    swarm, agent = "s_strings", "a_strings"
    spaces.grant(agent, swarm)
    result = spaces.publish(swarm, agent, canonical, 0.9, 0.8, ["ev:a_strings:1"])
    assert result["outcome"] in {"adopted", "revised", "chosen", "kept", "duplicate"}, (text, result)
    belief = spaces.belief(swarm, canonical)
    assert belief is not None and belief["statement"] == canonical, (text, belief)
    found = [sexpr.render(sexpr.read_result(r)[1]) for r in spaces.query(swarm, f"(Current {canonical} $t $s)")]
    assert found == [canonical], f"{text!r} read back as {found}"


@needs_petta
def test_every_character_alone_or_between_letters_crosses_into_the_commons_or_is_refused(spaces):
    # Time: 2 publishes, 2 belief reads and 2 queries for each of the 160 characters (128 ASCII, 32 edge).
    for char in [*map(chr, range(128)), *EDGES]:
        for text in (char, f"a{char}b"):
            _crosses(spaces, text)


@needs_petta
def test_random_strings_cross_into_the_commons_unchanged_or_are_refused(spaces):
    for text in random_texts(seed=352, count=300):
        _crosses(spaces, text)
