"""Purpose: translate a mind's beliefs, as its own space saves them, into commons statements, and back.

A mind's belief-claim, belief-derived and assimilate-belief write (Belief domain relation value (stv f c) source) with
string fields (hive/runtime/extensions/helper_metta.py). Non-Axiomatic Logic writes a relation r between a and b as the
inheritance of their product to r, so the belief is the statement (--> (x domain value) relation) with the same truth
value (P. Wang, Non-Axiomatic Logic, 2013, NAL-4). A field that spells a symbol, and no number, becomes that symbol, so a
belief and a publish of the same terms are one statement in a swarm's view; any other field stays a string. Confidence
1 becomes the commons' cap, 0.99, since a commons statement holds 0 < c < 1 and revision caps there.

belief_statement is total on saved atoms: every text gives a statement or None. statement_belief inverts it on its
image: statement_belief(*belief_statement(b)) is b for every belief b of that shape with 0 < c <= 0.99.
"""

from __future__ import annotations

import math

from . import sexpr

MAX_CONFIDENCE = 0.99   # lib_hive's hive-truth-revision caps confidence here


def term(text):
    """A belief field as a statement term: the symbol it spells, else the string itself."""
    text = str(text)
    if sexpr.SYMBOL.fullmatch(text) and not sexpr.NUMBER.fullmatch(text):
        return text
    return sexpr.Str(text)


def _field(node):
    """A statement term back to the field's text; None for anything but a symbol or a string."""
    if isinstance(node, sexpr.Str):
        return str(node)
    if isinstance(node, str) and not isinstance(node, sexpr.Var):
        return node
    return None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def belief_statement(atom):
    """(statement text, f, c) for one saved atom's text, or None when it isn't
    (Belief domain relation value (stv f c) source) with each field a string or symbol, 0 <= f <= 1 and c > 0, or a
    field can't cross into the commons grammar."""
    try:
        value = sexpr.parse(atom)
    except sexpr.SexprError:
        return None
    if not (isinstance(value, list) and len(value) == 6 and value[0] == "Belief"):
        return None
    fields = [_field(node) for node in value[1:4]]
    tv = value[4]
    if None in fields or not (isinstance(tv, list) and len(tv) == 3 and tv[0] == "stv"):
        return None
    f, c = _number(tv[1]), _number(tv[2])
    if f is None or c is None or not 0.0 <= f <= 1.0 or c <= 0.0:
        return None
    domain, relation, val = fields
    try:
        statement = sexpr.safe_commons_statement(sexpr.render(["-->", ["x", term(domain), term(val)], term(relation)]))
    except sexpr.SexprError:
        return None
    return statement, f, min(c, MAX_CONFIDENCE)


def statement_belief(statement, f, c, source="omega"):
    """The Belief atom text a statement (--> (x domain value) relation) and its truth value come from; None for a
    statement of any other shape."""
    try:
        value = sexpr.parse(statement)
    except sexpr.SexprError:
        return None
    if not (isinstance(value, list) and len(value) == 3 and value[0] == "-->"
            and isinstance(value[1], list) and len(value[1]) == 3 and value[1][0] == "x"):
        return None
    fields = [_field(node) for node in (value[1][1], value[2], value[1][2])]
    if None in fields:
        return None
    return sexpr.render(["Belief", *(sexpr.Str(x) for x in fields), ["stv", float(f), float(c)], sexpr.Str(source)])


def belief_domain(atom):
    """The domain a saved belief is about, as its field's text, or None for an atom the translation refuses."""
    got = belief_statement(atom)
    return None if got is None else _field(sexpr.parse(got[0])[1][1])


def domain_pattern(domain):
    """The pattern a read grant narrowed to one domain holds: every belief about it, whatever its relation and value."""
    return sexpr.render(["-->", ["x", term(domain), sexpr.Var("$value")], sexpr.Var("$relation")])
