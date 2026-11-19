"""Purpose: say what a mind's MeTTa command can reach when its PeTTa runs it, so the policy gate runs MeTTa that stays on
the mind's own memory spaces without asking and asks a person about anything that reaches further or that it can't see.

Jon's call on omega-flagship/omegahive#76 (issuecomment-6832781011): MeTTa a mind runs on its own spaces needs no
person's permission; a grounded call that reaches outside the sandbox (py-call, files, the network) still asks, and a
person can tighten it. So the gate looks at what an expression can reach, not at the skill's name, and whatever it
cannot resolve asks.

The model is PeTTa ae66fa8's, the commit the installers pin. ``read`` follows its reader (src/parser.pl ``sread``) and
``reach`` follows its translator (src/translator.pl ``translate_expr``), which decides which argument positions run as
calls. Probes on that commit showed:

- ``add-atom`` and ``remove-atom`` keep their atom as written, and a ``match`` pattern stays data;
- a ``match`` template runs its literal calls, also inside a data constructor such as ``(Wrap (f))``;
- ``match`` and ``get-atoms`` build a Prolog goal from their first argument (src/spaces.pl:48 and :63,
  ``Term =.. [Space, Rel | PatArgs]``), so anything but a space handle runs as a predicate: ``(match shell ("id") ok)``
  calls SWI's shell/1; and after ``(get-atoms &self)`` a bare function name such as ``canary`` runs that function, where
  before it stayed data;
- an atom bound from a space, ``sread`` or ``get-atoms`` never runs again unless ``eval`` is applied to it;
- a variable in head position calls whatever function it holds, even one named like a stream operation, such as
  ``($unique (...))`` with ``$unique`` bound to py-call: PeTTa rewrites ``trace!``, ``unique`` and their kin only under
  an atom head and only in the shapes its rules match, so ``(unique 1 2)`` calls a ``unique`` the mind defined;
- the arguments of a head with no definition still run;
- a let or case pattern runs any call in it before the value is matched, a builtin often in reverse, so
  ``(let (cons-atom $f $t) (quote (py-call + q)) ...)`` binds ``$f`` to py-call; only a pattern of variables, literals
  and data with no symbol, variable or expression in head position is matched position by position;
- a form's value is its own: prog1's is its first argument's, and-then's is B's only when A is true, and quote puts in
  the variables bound by then; and a variable is one Prolog variable across the whole command, so a let in one branch
  of a progn binds it for the next. The gate trusts only the values of VALUE_FORMS, each checked against PeTTa, and
  leaves every other value unknown;
- atoms differ by kind as well as text: the string "true", the variable $true and the symbol true are three atoms, and
  1 and 1.0 are two, so if, and-then and or-else take their true branch only on the symbol true (src/translator.pl:176,
  :183, :202, :205), and two values of different kinds never join into one; a condition holding a variable decides
  nothing, since a let or case pattern later in the command can bind it to true before the test runs (:207, :430);
- cut is a form only with no arguments (src/translator.pl:139); ``(cut (f))`` is a call of cut, and its arguments run;
- ``space-handle`` resolves any registered name, and the registry holds other spaces beside the memory spaces, such as
  ``skills``, the skill directory, so a write through a name reaches whatever space it names;
- an equation added to any space, or imported into one, becomes a callable function, and removing an identical
  equation from any space erases it.

PeTTa treats a head with no definition as data, but a mind can define functions while it runs, so a head the gate
does not know asks. Quoting keeps an atom data: ``(match &beliefs (B $x) (quote (Found $x)))`` runs without asking.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


# ---- reading, as PeTTa's sread reads -------------------------------------------------------------------------------------

class Sym(str):
    """An atom (PeTTa's symbol), such as match or &persistent."""


class Var(str):
    """A $variable, named without the $."""


class Str(str):
    """A string literal, its escapes resolved."""


class ReadError(ValueError):
    pass


# sread splits tokens only at these characters, while its blanks skip any Prolog space, so a form feed, a vertical tab or
# a Unicode space outside a string would separate two tokens for one rule and join them for the other: text holding one
# there is refused rather than read one way here and the other way by the mind.
_DELIMITERS = frozenset(" \t\r\n()")
_BLANKS = frozenset(" \t\r\n")
# dcg/basics number//1: an optional sign, digits, an optional fraction and exponent, then a delimiter or the end.
_NUMBER = re.compile(r"[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}


class _Reader:
    def __init__(self, text):
        self.text = str(text)
        self.pos = 0

    def blanks(self):
        text, n = self.text, len(self.text)
        while self.pos < n and text[self.pos].isspace():
            if text[self.pos] not in _BLANKS:
                raise ReadError(f"whitespace {text[self.pos]!r} outside a string")
            self.pos += 1

    def expression(self):
        """One S-expression. Nesting is kept on a list, so its depth is bounded only by the text."""
        stack = []
        while True:
            self.blanks()
            if self.pos >= len(self.text):
                raise ReadError("unexpected end")
            ch = self.text[self.pos]
            if ch == "(":
                self.pos += 1
                stack.append([])
                continue
            if ch == ")":
                if not stack:
                    raise ReadError("unexpected )")
                self.pos += 1
                value = tuple(stack.pop())
            else:
                value = self.leaf()
            if not stack:
                return value
            stack[-1].append(value)

    def leaf(self):
        if self.text[self.pos] == '"':
            string = self.string_literal()
            if string is not None:
                return string
        start, text = self.pos, self.text
        while self.pos < len(text) and text[self.pos] not in _DELIMITERS:
            if text[self.pos].isspace():
                raise ReadError(f"whitespace {text[self.pos]!r} inside a name")
            self.pos += 1
        token = text[start:self.pos]
        if token.startswith('"'):
            # sread's atom rule: a token wrapped in quotes is a string, taken as written
            if len(token) >= 2 and token.endswith('"'):
                return Str(token[1:-1])
            raise ReadError("unterminated string")
        if _NUMBER.fullmatch(token):
            return float(token) if any(c in token for c in ".eE") else int(token)
        if token.startswith("$") and len(token) > 1:
            return Var(token[1:])
        return Sym({"True": "true", "False": "false"}.get(token, token))

    def string_literal(self):
        """sread's string_lit: \\n, \\t and \\r are control characters and \\X is X. None when it never closes, and then
        the token rule above reads the text, as sread backtracks to it."""
        text, i, out = self.text, self.pos + 1, []
        while i < len(text):
            ch = text[i]
            if ch == '"':
                self.pos = i + 1
                return Str("".join(out))
            if ch == "\\":
                if i + 1 >= len(text):
                    return None
                out.append(_ESCAPES.get(text[i + 1], text[i + 1]))
                i += 2
                continue
            out.append(ch)
            i += 1
        return None


def read(text):
    """The expression ``text`` holds, as PeTTa's sread reads it: nested tuples of Sym, Var, Str, int and float."""
    reader = _Reader(text)
    value = reader.expression()
    reader.blanks()
    if reader.pos != len(reader.text):
        raise ReadError("text after the expression")
    return value


# ---- what each head reaches ----------------------------------------------------------------------------------------------

# PeTTa builtins (src/metta.pl register_fun) that compute, compare, take atoms apart, print to the mind's log or read
# state, and so stay inside the mind. add-atom, remove-atom, match, get-atoms and the evaluating forms have their own
# rules below; every other builtin asks.
SAFE_BUILTINS = frozenset({
    "superpose", "empty", "+", "-", "*", "/", "%", "min", "max", "get-state",
    "<", ">", "==", "!=", "=?", "<=", ">=", "and", "or", "xor", "implies", "not", "sqrt", "exp", "log", "cos", "sin",
    "first-from-pair", "second-from-pair", "car-atom", "cdr-atom", "unique-atom", "alpha-unique-atom",
    "repr", "repra", "parse", "sread", "swrite", "println!", "atom_concat", "atom_chars", "copy_term", "term_hash",
    "first", "last", "append", "length", "size-atom", "sort", "msort", "member", "is-member", "is-alpha-member",
    "exclude-item", "list_to_set", "is-var", "is-ground", "is-expr", "is-space", "get-mettatype",
    "decons", "decons-atom", "get-type", "get-metatype", "=alpha", "concat", "cons", "reverse",
    "#+", "#-", "#*", "#div", "#//", "#mod", "#min", "#max", "#<", "#>", "#=", "#\\=",
    "union-atom", "cons-atom", "intersection-atom", "subtraction-atom", "index-atom", "id",
    "pow-math", "sqrt-math", "sort-atom", "abs-math", "log-math", "trunc-math", "ceil-math",
    "floor-math", "round-math", "sin-math", "cos-math", "tan-math", "asin-math", "random-int", "random-float",
    "acos-math", "atan-math", "isnan-math", "isinf-math", "min-atom", "max-atom", "current-time", "format-time",
})

# Builtins that reach past the mind's memory spaces, each with the reason a person sees on the approval. py-call,
# eval, reduce, call and translatePredicate have forms of their own below.
ASKING_BUILTINS = {
    "import!": "loads a file into a space, defining the functions in it",
    "change-state!": "changes the mind's runtime state",
    "bind!": "rebinds a space or token name",
    "readln!": "reads the mind's input stream",
    "exists_file": "looks at the file system",
    "library": "looks up a library path",
    "argv": "reads the mind's command line",
    "mm2-exec": "runs MORK code",
    "set_hook": "installs a runtime hook",
    "import_prolog_function": "imports a Prolog predicate as a function",
    "Predicate": "builds a Prolog goal",
    "callPredicate": "calls a Prolog predicate",
    "assertaPredicate": "adds a Prolog clause",
    "assertzPredicate": "adds a Prolog clause",
    "retractPredicate": "removes a Prolog clause",
    "add-translator-rule!": "changes how the mind compiles MeTTa",
    "remove-translator-rule!": "changes how the mind compiles MeTTa",
    "maplist": "applies a function chosen when it runs",
    "foldl": "applies a function chosen when it runs",
    "assert": "runs a check the gate does not model",
}

# The mind's memory spaces: the names register-default-runtime-spaces registers with role memory, each with its handle
# (hive/runtime/extensions/skills_runtime_spaces.metta). It also registers each name as an alias spelled the same, so a
# name reaches its space as a string or as a symbol. The registry holds other spaces beside these, such as skills, the
# skill directory (role affordance), and attention (role immune), so a name outside this table asks. test_metta_reach
# derives the table from the shipped MeTTa and checks that no other registration there reuses one of its names.
MEMORY_REGISTRY = {"persistent": "&persistent", "agenda": "&agenda", "beliefs": "&beliefs", "world": "&world",
                   "events": "&events", "activity": "&activity", "cleanup": "&cleanup"}
MEMORY_SPACES = frozenset(MEMORY_REGISTRY.values())


@dataclass(frozen=True)
class SkillArgs:
    """0-based positions of a memory skill's arguments, as its SkillArg atoms type them: ``metta`` for the MeTTa atoms
    it reads with sread and removes or writes by, each of which must be one the gate can see is not code, and ``space``
    for the registered names it resolves to spaces, each of which must name one of the mind's memory spaces."""
    metta: tuple
    space: tuple = ()


# The hive's memory skills, reviewed to touch only the spaces their arguments name, the mind's memory spaces they name
# themselves, those spaces' own memory files and their trace atoms (hive/runtime/extensions/skills_space_mutation.metta,
# skills_memory.metta), keyed by (name, arity). persistent-cleanup-commit takes only a proposal's id: the atom it
# retires or merges is the one its stored proposal holds, which the gate cannot see, and the runtime refuses one that is
# or could be code before it acts (persistent-cleanup-commit-proposal). test_metta_reach pins each definition, so a
# change to one fails until it is reviewed again.
MEMORY_SKILLS = {
    ("space-merge-atoms", 4): SkillArgs(metta=(1, 2), space=(0,)),
    ("persistent-merge-atoms", 3): SkillArgs(metta=(0, 1)),
    ("retire-persistent-expression", 2): SkillArgs(metta=(0,)),
    ("persistent-expression", 1): SkillArgs(metta=(0,)),
    ("space-transform", 5): SkillArgs(metta=(1, 3), space=(0, 2)),
    ("persistent-cleanup-commit", 1): SkillArgs(metta=()),
}
# space-transform's one-argument form takes "source | pattern | target | replacement | reason" and splits it as
# hive_helpers.space_transform_spec_atom does (test_metta_reach checks the two agree).
SPEC_SKILL = ("space-transform", 1)
SPEC_ARGS = SkillArgs(metta=(1, 3), space=(0, 2))


def transform_spec_parts(spec):
    parts = [part.strip() for part in str(spec).strip().split("|")]
    return parts if len(parts) == 5 and all(parts) else None


def typed(atom):
    """atom as PeTTa tells atoms apart: each part's kind beside its text. Sym, Var and Str are all str, and Python
    equates 1 with 1.0, so text alone makes "true", $true and true one atom, where PeTTa's == and unification keep them
    three (src/parser.pl reads a string as a Prolog string and $x as a variable)."""
    return tuple(map(typed, atom)) if isinstance(atom, tuple) else (type(atom).__name__, atom)


@dataclass(frozen=True, eq=False)
class Lit:
    """A value the gate knows: the literal atom it is. Two are equal when their atoms are, by kind and text (typed)."""
    atom: object

    def __eq__(self, other):
        return isinstance(other, Lit) and typed(self.atom) == typed(other.atom)

    def __hash__(self):
        return hash(typed(self.atom))


@dataclass(frozen=True)
class Space:
    """A space handle: "memory" for one of the mind's memory spaces, "self" for &self, "other" for any other."""
    kind: str


UNKNOWN = None


def _join(a, b):
    return a if a == b else UNKNOWN


def _vars(pattern):
    if isinstance(pattern, Var):
        yield pattern
    elif isinstance(pattern, tuple):
        for item in pattern:
            yield from _vars(item)


def _shape_only(pattern):
    """True when PeTTa can only unify ``pattern`` with a value position by position: no part of it has a symbol, a
    variable or an expression in head position. PeTTa compiles a let pattern as an expression (src/translator.pl:207)
    and a case pattern through constrain_args (:428), so such a part runs as a call before the value is matched, a
    builtin often in reverse: (cons-atom $f $t) against (py-call + q) gives $f py-call, where position gives +, and a
    case pattern (cons $f $t) splits head from tail."""
    if not isinstance(pattern, tuple):
        return True
    if pattern and isinstance(pattern[0], (Sym, Var, tuple)):
        return False
    return all(_shape_only(item) for item in pattern)


def _bind(pattern, value, env):
    """Bind pattern's variables to what value shows of them; unknown where it shows nothing, and unknown for every
    variable of a pattern that is not _shape_only, since a call in it decides what they get."""
    if not _shape_only(pattern):
        for var in _vars(pattern):
            env[var] = UNKNOWN
        return
    if isinstance(pattern, Var):
        if str(pattern) != "_":
            env[pattern] = value if pattern not in env else _join(env[pattern], value)
    elif isinstance(pattern, tuple) and isinstance(value, Lit) and isinstance(value.atom, tuple) \
            and len(value.atom) == len(pattern):
        for p, a in zip(pattern, value.atom):
            _bind(p, Lit(a), env)
    else:
        for var in _vars(pattern):
            env[var] = UNKNOWN


def _code_change(op, atom, env):
    """Why removing or writing ``atom`` changes code: PeTTa compiles an (= ...) atom added to any space into a function
    and erases the function when an identical one is removed from any space (src/spaces.pl), and a (: ...) atom changes
    how later calls compile. An atom or a head the gate cannot see could be either.

    A variable written in the command is looked up; a variable inside a value the gate holds (sread's, say) is that
    value's own fresh variable, which PeTTa can bind to anything when it matches, so it is never looked up and always
    counts as unseen."""
    if isinstance(atom, Var):
        value = env.get(atom, UNKNOWN)
        if not isinstance(value, Lit):
            return {f"{op} of an atom the gate cannot see, which could be a function definition"}
        atom, env = value.atom, {}
    if isinstance(atom, Var):
        return {f"{op} of an atom the gate cannot see, which could be a function definition"}
    if not isinstance(atom, tuple) or not atom:
        return set()
    head = atom[0]
    if isinstance(head, Var):
        value = env.get(head, UNKNOWN)
        if not isinstance(value, Lit) or isinstance(value.atom, Var):
            return {f"{op} of an atom whose head the gate cannot see, which could be a function definition"}
        head = value.atom
    if head == "=":
        return {f"{op} of a function definition changes the mind's code"}
    if head == ":":
        return {f"{op} of a type declaration changes how the mind compiles calls"}
    return set()


class _Walk:
    """Walks every position PeTTa's translator compiles as a call, collecting why a person must decide."""

    def walk(self, e, env):
        """(reasons, value) for running e with variables bound as in env."""
        if isinstance(e, Var):
            return set(), env.get(e, UNKNOWN)
        if not isinstance(e, tuple):
            return set(), _atom(e)
        if not e:
            return set(), Lit(e)
        e = _streamops(e)
        head, args = e[0], e[1:]
        if isinstance(head, Var):
            bound = env.get(head, UNKNOWN)
            if isinstance(bound, Lit) and isinstance(bound.atom, Sym):
                # dispatched when it runs: the arguments are evaluated first and the symbol is called as a function, so
                # a form's name held in a variable (quote, eval, let) is no form there
                return self.call(str(bound.atom), args, env)
            return {f"calls whatever ${head} holds when it runs"}, UNKNOWN
        if isinstance(head, tuple):
            reasons, _ = self.walk(head, env)
            return reasons | {"puts an expression in head position, which the mind dispatches when it runs"}, UNKNOWN
        if not isinstance(head, Sym):
            reasons, _ = self.args(args, env)   # a string or number head is data; its arguments still run
            return reasons, UNKNOWN
        form = _FORMS.get(str(head))
        if form is not None:
            reasons, value = form(self, args, env)
            return reasons, value if str(head) in VALUE_FORMS else UNKNOWN
        return self.call(str(head), args, env)

    def args(self, args, env):
        reasons, values = set(), []
        for a in args:
            r, v = self.walk(a, env)
            reasons |= r
            values.append(v)
        return reasons, values

    def call(self, name, args, env):
        reasons, values = self.args(args, env)
        if name in SAFE_BUILTINS:
            if name in ("sread", "parse") and values and isinstance(values[0], Lit) and isinstance(values[0].atom, Str):
                try:
                    return reasons, Lit(read(values[0].atom))
                except ReadError:
                    return reasons, UNKNOWN
            return reasons, UNKNOWN
        if name in ASKING_BUILTINS:
            return reasons | {f"{ASKING_BUILTINS[name]} ({name})"}, UNKNOWN
        if name == "get-atoms" and len(values) == 1:
            return reasons | _space_read(name, values[0]), UNKNOWN
        if name == "metta" and len(values) == 1:
            # Omega's metta skill: (= (metta $str) (let $code (sread $str) (repr (swrite (eval $code)))))
            return reasons | self.evaluate_text(values[0], "evaluates MeTTa text the gate cannot see"), UNKNOWN
        if name == "space-handle" and len(values) == 1:
            return reasons, _named_space(values[0])
        if (name, len(values)) in MEMORY_SKILLS:
            return reasons | _memory_arguments(name, MEMORY_SKILLS[name, len(values)], values), UNKNOWN
        if (name, len(values)) == SPEC_SKILL:
            spec = values[0]
            parts = transform_spec_parts(spec.atom) if isinstance(spec, Lit) and isinstance(spec.atom, Str) else None
            if parts is None:
                return reasons | {"space-transform with a spec the gate cannot read"}, UNKNOWN
            return reasons | _memory_arguments(name, SPEC_ARGS, [Lit(Str(part)) for part in parts]), UNKNOWN
        return reasons | {f"uses {name}, which is not a reviewed function (quote data to keep it from running)"}, UNKNOWN

    def evaluate_text(self, value, unseen):
        if not (isinstance(value, Lit) and isinstance(value.atom, Str)):
            return {unseen}
        try:
            expression = read(value.atom)
        except ReadError as exc:
            return {f"the gate cannot read its MeTTa the way the mind will ({exc})"}
        reasons, _ = self.walk(expression, {})
        return reasons


def _memory_atoms(name, values):
    """A memory skill's MeTTa arguments, each a string the skill reads with sread: it must be one the gate can read and
    see is not code."""
    reasons = set()
    for value in values:
        if not (isinstance(value, Lit) and isinstance(value.atom, Str)):
            reasons.add(f"{name} with a MeTTa argument the gate cannot see")
            continue
        try:
            atom = read(value.atom)
        except ReadError as exc:
            # The gate's reader refuses some text the mind's reads (whitespace it treats two ways), so this asks.
            reasons.add(f"{name} with a MeTTa argument the gate cannot read the way the mind will ({exc})")
            continue
        reasons |= _code_change(name, atom, {})
    return reasons


def _memory_arguments(name, args, values):
    """Why a memory skill's arguments ask (SkillArgs): a MeTTa atom the gate cannot see is not code, or a space name
    that is not one of the mind's memory spaces."""
    reasons = _memory_atoms(name, [values[i] for i in args.metta])
    if any(_named_space(values[i]) != Space("memory") for i in args.space):
        reasons.add(f"{name} on a space the gate cannot tell is one of the mind's memory spaces")
    return reasons


def _named_space(value):
    """The space a registered name resolves to, as space-handle resolves it: one of the mind's memory spaces only for a
    name in MEMORY_REGISTRY, as a string or as its alias; any other literal names another space or none, and a value the
    gate cannot see could name any."""
    if not isinstance(value, Lit):
        return UNKNOWN
    return Space("memory" if isinstance(value.atom, (Str, Sym)) and value.atom in MEMORY_REGISTRY else "other")


def _atom(a):
    if isinstance(a, Sym) and a.startswith("&"):
        if a == "&self":
            return Space("self")
        return Space("memory" if a in MEMORY_SPACES else "other")
    return Lit(a)


# ---- forms PeTTa's translator compiles specially (src/translator.pl translate_expr) ---------------------------------------

def _unreadable(w, args, env):
    return {"uses a form the gate cannot read"}, UNKNOWN


def _evaluate_all(w, args, env):
    """progn: every argument runs, and its value is the last one's."""
    reasons, values = w.args(args, env)
    return reasons, values[-1] if values else UNKNOWN


def _first(w, args, env):
    """prog1: every argument runs, and its value is the first one's."""
    reasons, values = w.args(args, env)
    return reasons, values[0] if values else UNKNOWN


TRUE, FALSE = Lit(Sym("true")), Lit(Sym("false"))


def _shortcut(when_true, when_not):
    """and-then and or-else (src/translator.pl and-then, or-else): both arguments may run; the value is when_true(B)
    when A's value is the symbol true, and when_not(B) for any other ground value, "true" included (:202, :205). A value
    the gate cannot see, or one holding a variable that a later pattern may bind to true, could be either."""
    def form(w, args, env):
        if len(args) != 2:
            return _unreadable(w, args, env)
        reasons, (a, b) = w.args(args, env)
        if _ground(a):
            return reasons, when_true(b) if a == TRUE else when_not(b)
        return reasons, _join(when_true(b), when_not(b))
    return form


def _ground(value):
    """A value the gate knows whole: a space, or an atom with no variable in it, which PeTTa could bind to anything."""
    return isinstance(value, Space) or (isinstance(value, Lit) and next(_vars(value.atom), None) is None)


def _quote(w, args, env):
    """quote's value is its term as written with the variables bound by then put in: (let $x 5 (quote (a $x))) is (a 5).
    A PeTTa variable is one Prolog variable across the whole command, so one the gate can't pin to a ground value may be
    bound elsewhere, before or after, and a term holding one is unknown."""
    if len(args) != 1:
        return _unreadable(w, args, env)
    term = _substitute(args[0], {v: env[v] for v in _vars(args[0]) if _ground(env.get(v)) and isinstance(env[v], Lit)})
    return set(), Lit(term) if next(_vars(term), None) is None else UNKNOWN


def _let(w, args, env):
    if len(args) != 3:
        return _unreadable(w, args, env)
    pattern, value, body = args
    r1, v = w.walk(value, env)
    r0, _ = w.walk(pattern, env)   # the translator compiles a let pattern as an expression too
    inner = dict(env)
    _bind(pattern, v, inner)
    r2, out = w.walk(body, inner)
    return r0 | r1 | r2, out


def _let_star(w, args, env):
    if len(args) != 2 or not isinstance(args[0], tuple):
        return _unreadable(w, args, env)
    binds, body = args
    if not binds:
        return w.walk(body, env)
    if not isinstance(binds[0], tuple) or len(binds[0]) != 2:
        return _unreadable(w, args, env)
    return _let(w, (binds[0][0], binds[0][1], (Sym("let*"), binds[1:], body)), env)


def _match(w, args, env):
    if len(args) != 3:
        return _unreadable(w, args, env)
    reasons, space = w.walk(args[0], env)
    reasons = set(reasons) | _space_read("match", space)
    inner = dict(env)
    for var in _vars(args[1]):
        inner.setdefault(var, UNKNOWN)   # bound from the space's atoms, which stay data
    r, _ = w.walk(args[2], inner)
    return reasons | r, UNKNOWN


def _space_read(op, space):
    """Why reading ``space`` asks. PeTTa's match and get-atoms call their first argument as a Prolog predicate, so only
    a handle the gate sees is one of the mind's memory spaces is read without asking; a symbol, a literal, any other
    handle or a value the gate cannot see asks. So does &self: its atoms are the mind's code and setup, and reading them
    through get-atoms makes PeTTa run a function named later by its bare name (test_metta_reach's PeTTa run)."""
    if space == Space("memory"):
        return set()
    if space == Space("self"):
        return {f"{op} on &self reads the mind's own code and setup"}
    return {f"{op} on something the gate cannot tell is one of the mind's memory spaces, which PeTTa runs as a Prolog "
            f"predicate"}


def _space_write(op):
    def form(w, args, env):
        if len(args) != 2:
            return _unreadable(w, args, env)
        reasons, space = w.walk(args[0], env)
        reasons = set(reasons) | _code_change(op, args[1], env)
        if space == Space("self"):
            reasons.add(f"{op} on &self changes the mind's own code and setup")
        elif space != Space("memory"):
            reasons.add(f"{op} on a space the gate cannot tell is one of the mind's memory spaces")
        # remove-atom gives false when an equation it is given erases nothing (src/spaces.pl:27-41), so its value is
        # known only for an atom that is surely no equation; add-atom always gives true (:10, :24)
        if op == "remove-atom" and _code_change(op, args[1], env):
            return reasons, UNKNOWN
        return reasons, TRUE
    return form


def _eval(w, args, env):
    """PeTTa's eval translates its argument when it runs (src/metta.pl eval/2), with the variables bound by then put in
    place first, so an atom a variable holds runs as code there: one the gate holds as a ground value is walked, and any
    other asks, one the command binds out of the gate's sight too, such as a let in an earlier branch of a progn, since a
    PeTTa variable is one Prolog variable across the whole command."""
    if len(args) != 1:
        return _unreadable(w, args, env)
    unseen = sorted(f"${v}" for v in set(_vars(args[0])) if not _ground(env.get(v)))
    if unseen:
        return {f"evaluates an atom the gate cannot see ({', '.join(unseen)})"}, UNKNOWN
    term = _substitute(args[0], env)
    return w.walk(term, {v: env[v] for v in _vars(term) if v in env})


def _substitute(term, env):
    """term with each variable bound to a known atom replaced by it, as PeTTa instantiates a term before translating it."""
    if isinstance(term, Var):
        value = env.get(term)
        return value.atom if isinstance(value, Lit) else term
    if isinstance(term, tuple):
        return tuple(_substitute(item, env) for item in term)
    return term


def _reduce(w, args, env):
    """reduce translates its expression's arguments and dispatches on its head when it runs (src/translator.pl), so the
    head is called as a function, never compiled as a form."""
    target = args[0] if len(args) == 1 else None
    if isinstance(target, tuple) and target and isinstance(target[0], Sym):
        return w.call(str(target[0]), target[1:], env)
    return {"reduces an expression chosen when it runs"}, UNKNOWN


def _prolog(w, args, env):
    """call and translatePredicate run a Prolog goal built from their argument, its arguments translated first."""
    goal = args[0] if len(args) == 1 else None
    if not (isinstance(goal, tuple) and goal):
        return {"calls a Prolog goal chosen when it runs"}, UNKNOWN
    reasons, _ = w.args(goal[1:], env)
    return reasons | {f"calls the Prolog predicate {goal[0]} directly"}, UNKNOWN


def _py_call(w, args, env):
    target = args[0] if len(args) == 1 else None
    if isinstance(target, tuple) and target and isinstance(target[0], Sym):
        reasons, _ = w.args(target[1:], env)
        return reasons | {f"calls Python ({target[0]})"}, UNKNOWN
    reasons, _ = w.args(args, env)
    return reasons | {"calls Python"}, UNKNOWN


def _superpose(w, args, env):
    if len(args) == 1 and isinstance(args[0], tuple):
        reasons, _ = w.args(args[0], env)
        return reasons, UNKNOWN
    return w.call("superpose", args, env)


def _hyperpose(w, args, env):
    """hyperpose runs a literal list's elements as calls, and evaluates each element of a list it gets when it runs
    (src/translator.pl hyperpose_runtime)."""
    if len(args) == 1 and isinstance(args[0], tuple):
        reasons, _ = w.args(args[0], env)
        return reasons, UNKNOWN
    reasons, _ = w.args(args, env)
    return reasons | {"evaluates atoms it gets when it runs (hyperpose)"}, UNKNOWN


def _if(w, args, env):
    if len(args) not in (2, 3):
        return _unreadable(w, args, env)
    reasons, values = w.args(args, env)
    if len(values) == 2 or values[0] == TRUE:   # without an else, it gives a value only when it takes then
        return reasons, values[1]
    # it takes then only when the condition's value is == true when the test runs (src/translator.pl:183), so any other
    # ground value takes else, "true" and x as much as false; a value holding a variable may be bound to true by then,
    # by a let or case pattern anywhere in the command (:207, :430), so it joins as an unknown one does
    return reasons, values[2] if _ground(values[0]) else _join(values[1], values[2])


def _case(w, args, env):
    if len(args) != 2 or not isinstance(args[1], tuple):
        return _unreadable(w, args, env)
    reasons, key = w.walk(args[0], env)
    reasons, out = set(reasons), None
    for i, pair in enumerate(args[1]):
        if not isinstance(pair, tuple) or len(pair) != 2:
            return _unreadable(w, args, env)
        inner = dict(env)
        # A case pattern is unified with the key, but a part of it headed by a function is compiled as a call first
        # (src/translator.pl constrain_args), so the pattern is walked like an expression too.
        r0, _ = w.walk(pair[0], env)
        _bind(pair[0], key, inner)
        r, v = w.walk(pair[1], inner)
        reasons |= r0 | r
        out = v if i == 0 else _join(out, v)
    return reasons, out


def _one(w, args, env):
    return w.walk(args[0], env) if len(args) == 1 else _unreadable(w, args, env)


def _second(w, args, env):
    """with_mutex and sealed: the first argument is a lock name or the variables to seal; the second runs."""
    return w.walk(args[1], env) if len(args) == 2 else _unreadable(w, args, env)


def _dispatches(w, args, env):
    """forall and foldall reduce their generator and test when they run, applying the value one computes as a
    function."""
    reasons, _ = w.args(args, env)
    return reasons | {"applies functions chosen when it runs"}, UNKNOWN


def _binder(arity, positions):
    """foldl-atom, map-atom and filter-atom at their special-form arity: the arguments at ``positions`` are variables
    bound to elements and the rest run. At any other arity they are the run-time predicates that apply a function value
    to each element (src/metta.pl 'map-atom'/3 and its kin)."""
    def form(w, args, env):
        if len(args) != arity:
            reasons, _ = w.args(args, env)
            return reasons | {"applies a function chosen when it runs"}, UNKNOWN
        inner = dict(env)
        for i in positions:
            if isinstance(args[i], Var):
                inner[args[i]] = UNKNOWN
        reasons = set()
        for i, a in enumerate(args):
            if i not in positions:
                r, _ = w.walk(a, inner)
                reasons |= r
        return reasons, UNKNOWN
    return form


def _lambda(w, args, env):
    if len(args) != 2:
        return _unreadable(w, args, env)
    inner = dict(env)
    for var in _vars(args[0]):
        inner[var] = UNKNOWN
    reasons, _ = w.walk(args[1], inner)   # counted where it is written: the gate cannot follow it to its calls
    return reasons, UNKNOWN


def _cut(w, args, env):
    """cut is a form only bare (src/translator.pl:139, T = []): with arguments it is a call of cut like any other, which
    runs its arguments first (:333), so the gate walks them and asks as for any function nobody reviewed."""
    if args:
        return w.call("cut", args, env)
    return set(), TRUE


_FORMS = {
    "quote": _quote, "let": _let, "chain": _let, "let*": _let_star, "match": _match,
    "add-atom": _space_write("add-atom"), "remove-atom": _space_write("remove-atom"),
    "eval": _eval, "reduce": _reduce, "call": _prolog, "translatePredicate": _prolog, "py-call": _py_call,
    "superpose": _superpose, "hyperpose": _hyperpose, "if": _if, "case": _case, "catch": _one, "once": _one,
    "transaction": _one, "collapse": _one, "test": _evaluate_all, "progn": _evaluate_all, "prog1": _first,
    "and-then": _shortcut(lambda b: b, lambda b: FALSE), "or-else": _shortcut(lambda b: TRUE, lambda b: b),
    "with_mutex": _second, "sealed": _second, "forall": _dispatches, "foldall": _dispatches,
    "foldl-atom": _binder(5, (2, 3)), "map-atom": _binder(3, (1,)), "filter-atom": _binder(3, (1,)), "|->": _lambda,
    "cut": _cut,
}

# The forms whose value the gate models exactly, each checked against the value PeTTa ae66fa8 gives
# (test_metta_reach's value test runs every one): every other form's value is unknown, so a variable it binds asks
# wherever a value matters, in head position, as a space, in eval or as an atom written. A guessed value let code run
# unasked three times on #335 (a stream operation's name, a pattern's call, prog1's last value), so none is guessed.
# Left out: match, superpose and hyperpose, which give many values; collapse, their list; catch, an error term when
# its argument fails; test, which ends the run when it fails; eval and the Prolog and Python calls; and the forms that
# apply a function chosen when they run.
VALUE_FORMS = frozenset({"quote", "let", "chain", "let*", "if", "case", "progn", "prog1", "and-then", "or-else", "once",
                         "transaction", "with_mutex", "sealed", "add-atom", "remove-atom", "cut", "reduce"})


def _streamops(e):
    """PeTTa's rewrite_streamops (src/translator.pl:96-111) where its safe_rewrite_streamops applies it (:114): only
    under a literal atom head, so a variable head is never rewritten, even one named $trace! or $unique, and calls
    whatever it holds; and only in the shapes its clauses match: trace! prints its first argument and runs its second,
    unique and alpha-unique run their one argument, and union, intersection and subtraction run their two superpose
    lists. Any other shape is a call of that name, which the mind may have defined, so it asks."""
    head = e[0]
    if not isinstance(head, Sym):
        return e
    if head == "trace!" and len(e) == 3:
        return (Sym("progn"), (Sym("println!"), e[1]), e[2])
    if head in ("unique", "alpha-unique") and len(e) == 2:
        return (Sym("progn"), e[1])
    if head in ("union", "intersection", "subtraction") and len(e) == 3 and all(_superposed(a) for a in e[1:]):
        return (Sym("progn"),) + e[1:]
    return e


def _superposed(a):
    return isinstance(a, tuple) and bool(a) and isinstance(a[0], Sym) and a[0] == "superpose"


# ---- the answer ------------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Reach:
    """What running a command reaches: ``asks`` holds why a person must decide, empty when it stays in the mind's
    own memory spaces."""
    asks: tuple

    @property
    def own(self):
        return not self.asks


def reach(command):
    """What running ``command`` (a mind's command text, such as (metta "(match &persistent ...)")) can reach.

    Time: one pass over the command and over the MeTTa text a metta call holds, linear in their size."""
    try:
        expression = read(command)
    except ReadError as exc:
        return Reach((f"the gate cannot read it the way the mind will ({exc})",))
    try:
        reasons, _ = _Walk().walk(expression, {})
    except RecursionError:
        return Reach(("nests deeper than the gate can follow",))
    return Reach(tuple(sorted(reasons)))
