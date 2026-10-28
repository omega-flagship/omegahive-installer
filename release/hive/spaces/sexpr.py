"""S-expression parsing and safe rendering for MeTTa text crossing the hive API.

Agents send statements as MeTTa text.  Before any of it reaches the
interpreter it is parsed here and re-rendered from a restricted grammar:
symbols, numbers, strings and nested expressions only.  That rules out
evaluation (``!``), space handles (``&name``), comments and, unless allowed
for query patterns, variables.
"""

from __future__ import annotations

import re

SYMBOL = re.compile(r"^[A-Za-z_\-+*/<>=|.:?#'^~%][A-Za-z0-9_\-+*/<>=|.:?#'^~%]*$")
VARIABLE = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_\-]*$")
NUMBER = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")
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


def parse(text, allow_vars=False):
    """Parse one expression into nested lists of str/int/float/Var/Str."""
    tokens = tokenize(str(text))
    if not tokens:
        raise SexprError("empty expression")
    pos = 0
    nodes = 0

    def atom(tok):
        if isinstance(tok, Str):
            return tok
        if NUMBER.match(tok):
            return float(tok) if any(c in tok for c in ".eE") else int(tok)
        if VARIABLE.match(tok):
            if not allow_vars:
                raise SexprError(f"variables are not allowed here: {tok}")
            return Var(tok)
        if SYMBOL.match(tok):
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
        if tok == "(":
            items = []
            while True:
                if pos >= len(tokens):
                    raise SexprError("missing )")
                if tokens[pos] == ")":
                    pos += 1
                    return items
                items.append(read(depth + 1))
        if tok == ")":
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


def safe_pattern(text):
    value = parse(text, allow_vars=True)
    return render(value)


def safe_symbol(name):
    name = str(name)
    if not SYMBOL.match(name):
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
        if tok == "(":
            items = []
            while tokens[pos] != ")":
                items.append(read())
            pos += 1
            return items
        if isinstance(tok, Str):
            return tok
        if NUMBER.match(tok):
            return float(tok) if any(c in tok for c in ".eE") else int(tok)
        return tok

    if not tokens:
        return None
    return read()
