"""Purpose: parse and render the restricted data grammar crossing the hive API.

Agents send statements as MeTTa text.  Before any of it reaches the
interpreter it is parsed here and re-rendered from a restricted grammar:
symbols, numbers, strings and nested expressions only.  That rules out
evaluation (``!``), space handles (``&name``), comments and, unless allowed
for query patterns, variables.
"""

from __future__ import annotations

import re

# Each pattern is a whole token and is applied with fullmatch: Python's $ also matches before a final newline, so
# match with ^...$ let a name like "sky\n" through safe_symbol as a second spelling of sky.
SYMBOL = re.compile(r"[A-Za-z_\-+*/<>=|.:?#'^~%][A-Za-z0-9_\-+*/<>=|.:?#'^~%]*")
VARIABLE = re.compile(r"\$[A-Za-z_][A-Za-z0-9_\-]*")
NUMBER = re.compile(r"-?\d+(\.\d+)?([eE][-+]?\d+)?")
MAX_DEPTH = 16
MAX_NODES = 256


class SexprError(ValueError):
    pass


class Var(str):
    """A $variable in a parsed pattern."""


class Str(str):
    """A quoted string literal."""


def tokenize(text):
    tokens, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch in "()":
            tokens.append(ch)
            i += 1
        elif ch == '"':
            j, buf = i + 1, []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    buf.append(text[j + 1])
                    j += 2
                else:
                    buf.append(text[j])
                    j += 1
            if j >= n:
                raise SexprError("unterminated string")
            tokens.append(Str("".join(buf)))
            i = j + 1
        elif ch == ";":
            raise SexprError("comments are not allowed")
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '()"':
                j += 1
            tokens.append(text[i:j])
            i = j
    return tokens


def _is(tok, paren):
    """Whether a token is that parenthesis, not a string holding it: a Str is a str, so "(" read as a string would
    otherwise open a list."""
    return tok == paren and not isinstance(tok, Str)


def parse(text, allow_vars=False):
    """Parse one expression into nested lists of str/int/float/Var/Str."""
    tokens = tokenize(str(text))
    if not tokens:
        raise SexprError("empty expression")
    pos = 0
    nodes = 0

    def atom(tok):
        if isinstance(tok, Str):
            # PeTTa's reader ends a string at any double quote, escaped or not, so one would cut the expression short:
            # a publish holding one stopped every commons write until a restart.
            if '"' in tok:
                raise SexprError("a string may not hold a double quote: the hive's MeTTa reader ends a string there")
            return tok
        if NUMBER.fullmatch(tok):
            return float(tok) if any(c in tok for c in ".eE") else int(tok)
        if VARIABLE.fullmatch(tok):
            if not allow_vars:
                raise SexprError(f"variables are not allowed here: {tok}")
            return Var(tok)
        if SYMBOL.fullmatch(tok):
            return tok
        raise SexprError(f"symbol not allowed: {tok!r}")

    def read(depth):
        nonlocal pos, nodes
        nodes += 1
        if nodes > MAX_NODES:
            raise SexprError("expression too large")
        if depth > MAX_DEPTH:
            raise SexprError("expression too deep")
        if pos >= len(tokens):
            raise SexprError("unexpected end")
        tok = tokens[pos]
        pos += 1
        if _is(tok, "("):
            items = []
            while True:
                if pos >= len(tokens):
                    raise SexprError("missing )")
                if _is(tokens[pos], ")"):
                    pos += 1
                    return items
                items.append(read(depth + 1))
        if _is(tok, ")"):
            raise SexprError("unexpected )")
        return atom(tok)

    value = read(0)
    if pos != len(tokens):
        raise SexprError("trailing input after expression")
    return value


def render(value):
    """Render a parsed value back to MeTTa text."""
    if isinstance(value, list):
        return "(" + " ".join(render(v) for v in value) + ")"
    if isinstance(value, Str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, float):
        return repr(value)
    return str(value)


def safe_statement(text):
    """Validate an agent-supplied statement and return its canonical text."""
    value = parse(text, allow_vars=False)
    if not isinstance(value, list) or not value:
        raise SexprError("a statement must be a non-empty expression")
    return render(value)


# A commons statement is a logical form: every list in it is headed by one of these connectives (NAL copulas,
# conjunction/disjunction/negation, and the product x). This restricts the logical grammar; the service must still pass
# these trees as quoted data because a library can define a function with the same name as a connective.
STATEMENT_HEADS = frozenset({"-->", "<->", "==>", "<=>", "&&", "||", "--", "x"})


def _logical(value):
    if isinstance(value, list):
        if not value or not isinstance(value[0], str) or isinstance(value[0], Str) or value[0] not in STATEMENT_HEADS:
            raise SexprError("a commons statement is a logical form: each list must start with one of "
                             + " ".join(sorted(STATEMENT_HEADS)))
        for item in value[1:]:
            _logical(item)


def safe_commons_statement(text):
    """A statement for a shared commons: valid syntax (safe_statement) and a logical form only (STATEMENT_HEADS)."""
    value = parse(text, allow_vars=False)
    if not isinstance(value, list) or not value:
        raise SexprError("a statement must be a non-empty expression")
    _logical(value)
    return render(value)


def safe_pattern(text):
    value = parse(text, allow_vars=True)
    return render(value)


def safe_link_pattern(text):
    """The statements a read grant admits, as lib_hive unifies them: one variable for every statement, or a logical
    form (safe_commons_statement's) that may hold variables, such as (--> (x home $value) $relation)."""
    value = parse(text, allow_vars=True)
    if not isinstance(value, Var):
        if not isinstance(value, list) or not value:
            raise SexprError("a link pattern is a variable or a logical form")
        _logical(value)
    return render(value)


def safe_symbol(name):
    name = str(name)
    if not SYMBOL.fullmatch(name):
        raise SexprError(f"symbol not allowed: {name!r}")
    return name


def read_result(text):
    """Parse interpreter output (more permissive: allows & handles and vars)."""
    tokens = tokenize(str(text))
    pos = 0

    def read():
        nonlocal pos
        tok = tokens[pos]
        pos += 1
        if _is(tok, "("):
            items = []
            while not _is(tokens[pos], ")"):
                items.append(read())
            pos += 1
            return items
        if isinstance(tok, Str):
            return tok
        if NUMBER.fullmatch(tok):
            return float(tok) if any(c in tok for c in ".eE") else int(tok)
        return tok

    if not tokens:
        return None
    return read()
