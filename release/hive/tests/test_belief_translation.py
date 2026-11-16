"""Purpose: a mind's saved belief (Belief domain relation value (stv f c) source) translates to the commons statement
(--> (x domain value) relation) by one pure function that is total on saved atoms and inverts on its image, so a
swarm's view reads a mind's beliefs and a mind's publishes as one kind of statement."""

import math
import random
import string

from hive.spaces import beliefs, sexpr
from hive.tests.test_commons_strings import random_char, random_text

SYMBOLIC = string.ascii_letters + string.digits + "_-+*/<>=|.:?#'^~%"   # sexpr.SYMBOL's characters


def word(rng):
    """1 to 12 characters of a symbol's alphabet: often a symbol, sometimes a number or neither (a leading digit)."""
    return "".join(rng.choice(SYMBOLIC) for _ in range(rng.randint(1, 12)))


def numeral(rng):
    return rng.choice([str(rng.randint(-99, 99)), f"{rng.uniform(-100, 100):.3f}", f"{rng.randint(1, 9)}e{rng.randint(-5, 5)}"])


def field(rng):
    """Any text a mind's belief-claim can write, a word, a numeral or any text a third of the time each. PeTTa can't
    read a double quote inside a string, so a mind's own space never holds one (and sexpr refuses it)."""
    pick = rng.random()
    if pick < 1 / 3:
        return word(rng)
    if pick < 2 / 3:
        return numeral(rng)
    return random_text(rng, 24, without='"')


def number(rng, low, high, open_low=False):
    """A float in [low, high], or (low, high] when open_low: an edge value a third of the time, else uniform."""
    edges = (low, high, (low + high) / 2, math.nextafter(low, high), math.nextafter(high, low), 0.1 + 0.2,
             beliefs.MAX_CONFIDENCE, 1.0)
    while True:
        x = rng.choice(edges) if rng.random() < 1 / 3 else rng.uniform(low, high)
        if low <= x <= high and not (open_low and x == low):
            return x


def belief_text(domain, relation, value, f, c, source="omega"):
    return sexpr.render(["Belief", sexpr.Str(domain), sexpr.Str(relation), sexpr.Str(value), ["stv", f, c],
                         sexpr.Str(source)])


def mutated(rng):
    """A belief's text with one to three characters deleted, inserted or replaced, or cut short: text just off the
    grammar, where a total function most plausibly fails."""
    text = belief_text(field(rng), field(rng), field(rng), number(rng, 0.0, 1.0), number(rng, 0.0, 5.0, True),
                       field(rng))
    for _ in range(rng.randint(1, 3)):
        at, edit = rng.randint(0, len(text)), rng.randrange(4)
        if edit == 0:
            text = text[:at] + text[at + 1:]
        elif edit == 1:
            text = text[:at] + random_char(rng) + text[at:]
        elif edit == 2:
            text = text[:at] + random_char(rng) + text[at + 1:]
        else:
            text = text[:at]
    return text


def test_a_belief_is_the_inheritance_of_its_product_to_its_relation():
    assert beliefs.belief_statement('(Belief "sky" "color" "blue" (stv 1.0 0.9) "omega")') == \
        ("(--> (x sky blue) color)", 1.0, 0.9)
    assert beliefs.belief_statement('(Belief "user" "prefers" "dark mode" (stv 0.9 0.8) "omega")') == \
        ('(--> (x user "dark mode") prefers)', 0.9, 0.8)
    assert beliefs.belief_statement('(Belief "user" "age" "42" (stv 1 1) "omega")') == \
        ('(--> (x user "42") age)', 1.0, beliefs.MAX_CONFIDENCE)   # a number stays a string; certainty is the cap
    for refused in ('(Belief "a" "b" (stv 0.5 0.5) "omega")', '(Belief "a" "b" "c" (stv 1.2 0.5) "omega")',
                    '(Belief "a" "b" "c" (stv 0.5 0) "omega")', '(Belief "a" "b" "c" (tv 0.5 0.5) "omega")',
                    '(Note "a" "b" "c" (stv 0.5 0.5) "omega")', '(Belief "a" "b" "c" (stv x 0.5) "omega")',
                    '(Belief "a" "b" "c" (stv 0.5 0.5) "omega"', '(Belief $a "b" "c" (stv 0.5 0.5) "omega")'):
        assert beliefs.belief_statement(refused) is None, refused


def test_any_text_translates_to_a_commons_statement_or_to_nothing():
    rng = random.Random(354)
    texts = [*(random_text(rng, 80) for _ in range(500)), *(mutated(rng) for _ in range(500))]
    translated = 0
    for text in texts:
        got = beliefs.belief_statement(text)
        if got is not None:
            statement, f, c = got
            assert sexpr.safe_commons_statement(statement) == statement, text
            assert 0.0 <= f <= 1.0 and 0.0 < c <= beliefs.MAX_CONFIDENCE, text
            translated += 1
    assert 0 < translated < len(texts)   # both outcomes were reached


def test_every_belief_of_the_grammar_translates():
    rng = random.Random(355)
    for _ in range(500):
        domain, relation, value, source = field(rng), field(rng), field(rng), field(rng)
        f, c = number(rng, 0.0, 1.0), number(rng, 0.0, 5.0, open_low=True)
        text = belief_text(domain, relation, value, f, c, source)
        got = beliefs.belief_statement(text)
        assert got is not None, text
        statement, tf, tc = got
        assert sexpr.safe_commons_statement(statement) == statement, text
        assert tf == f and tc == min(c, beliefs.MAX_CONFIDENCE), text


def test_the_translation_inverts_on_its_image():
    rng = random.Random(356)
    for _ in range(500):
        f, c = number(rng, 0.0, 1.0), number(rng, 0.0, beliefs.MAX_CONFIDENCE, open_low=True)
        text = belief_text(field(rng), field(rng), field(rng), f, c)
        statement, tf, tc = beliefs.belief_statement(text)
        assert beliefs.statement_belief(statement, tf, tc) == text
        assert beliefs.belief_statement(beliefs.statement_belief(statement, tf, tc)) == (statement, tf, tc)


def test_a_field_spelling_a_symbol_is_that_symbol_so_a_publish_of_the_same_terms_is_the_same_statement():
    rng = random.Random(357)
    kinds = set()
    for _ in range(300):
        d, r, v = field(rng), field(rng), field(rng)
        statement, _, _ = beliefs.belief_statement(belief_text(d, r, v, 1.0, 0.5))
        published = sexpr.render(["-->", ["x", beliefs.term(d), beliefs.term(v)], beliefs.term(r)])
        assert statement == published, (d, r, v)
        for text in (d, r, v):
            symbol = bool(sexpr.SYMBOL.fullmatch(text) and not sexpr.NUMBER.fullmatch(text))
            assert isinstance(beliefs.term(text), sexpr.Str) != symbol, text
            kinds.add(symbol)
    assert kinds == {True, False}   # fields of both kinds were drawn


def test_a_domain_pattern_admits_exactly_the_beliefs_about_that_domain():
    rng = random.Random(358)
    for _ in range(300):
        domain = field(rng)
        if not domain.strip():
            continue
        pattern = sexpr.parse(beliefs.domain_pattern(domain), allow_vars=True)
        assert sexpr.safe_link_pattern(beliefs.domain_pattern(domain)) == beliefs.domain_pattern(domain)
        statement, _, _ = beliefs.belief_statement(belief_text(domain, "r", "v", 1.0, 0.5))
        assert sexpr.parse(statement)[1][1] == pattern[1][1], domain


def test_a_statement_of_another_shape_is_no_belief():
    for statement in ("(--> sky blue)", "(--> (x a b c) r)", "(<-> (x a b) r)", "(--> (x a (x b c)) r)"):
        assert beliefs.statement_belief(statement, 1.0, 0.5) is None


def test_a_beliefs_domain_reads_back_as_written():
    rng = random.Random(359)
    for _ in range(300):
        domain = field(rng)
        assert beliefs.belief_domain(belief_text(domain, field(rng), field(rng), 1.0, 0.5)) == domain
    assert beliefs.belief_domain("(Note x)") is None
