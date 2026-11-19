"""Purpose: test that the policy gate decides a mind's MeTTa by what it reaches (Jon's call on omega-flagship/omegahive#76):
MeTTa on the mind's own memory spaces runs without asking and shows in the decision history, while MeTTa reaching past
them, or that the gate cannot resolve, asks a person, who can still make it ask. The tables the gate uses are derived
from the shipped MeTTa here, and its model of what PeTTa runs, and of the values it trusts, is checked against PeTTa
itself when PETTA_PATH has one, with the mind's runtime loaded where the gate relies on it: the spaces a name reaches
and the cleanup commit's refusal of code."""
import hashlib
import json
import os
import pathlib
import random
import re
import subprocess

import pytest

from hive.core import metta_reach, policy
from hive.core.metta_reach import ReadError, Str, Sym, Var, read, reach, typed
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_five_way_decisions import decide
from hive.tests.test_phase2_api import authorize

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXTENSIONS = ROOT / "hive" / "runtime" / "extensions"
PETTA = pathlib.Path(os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa")))
needs_petta = pytest.mark.skipif(not (PETTA / "run.sh").exists(), reason="set PETTA_PATH to a PeTTa checkout")


# ---- reading, as PeTTa's sread (src/parser.pl) reads ----------------------------------------------------------------------

@pytest.mark.parametrize("text,value", [
    ('(f "a\\"b" $x 12 -3.5 1e3 +5 True)', (Sym("f"), Str('a"b'), Var("x"), 12, -3.5, 1000.0, 5, Sym("true"))),
    ('"line\\nbreak\\q"', Str("line\nbreakq")),                  # \n is a newline, \q is q
    ('("a"b)', (Str("a"), Sym("b"))),                            # a string needs no space after it
    ('(12abc $ 1. ;b)', (Sym("12abc"), Sym("$"), Sym("1."), Sym(";b"))),   # no comments inside sread
    ('"a\\"', Str("a\\")),                                       # never closes, so read as a quoted token
    ('("a\x0cb")', (Str("a\x0cb"),)),                            # any character inside a string
])
def test_the_gate_reads_text_as_petta_reads_it(text, value):
    assert typed(read(text)) == typed(value)


@pytest.mark.parametrize("text", ['(a', 'a)', ')', '"abc', '(a)(b)', '(a\x0cb)', '(a\xa0b)', '\x0b(a)'])
def test_text_the_gate_cannot_read_as_petta_does_is_refused(text):
    """Whitespace other than space, tab, CR and LF separates tokens for sread's blanks but not for its token rule, so
    outside a string it is refused rather than read one way here and the other way by the mind."""
    with pytest.raises(ReadError):
        read(text)
    assert not reach(f'(metta "{_escaped(text)}")').own


# ---- what PeTTa ae66fa8 runs, as the probes found it ---------------------------------------------------------------------

@pytest.mark.parametrize("expression", [
    "(match &persistent (Note $x) $x)",                          # a bound atom is data
    "(add-atom &persistent (Note (shell \"x\")))",              # add-atom keeps its atom as written
    "(remove-atom &agenda (Goal \"g1\"))",
    "(match &beliefs (Belief $b (stv $f $c)) (quote (Low $b $c)))",   # quote keeps a template data
    "(match (space-handle \"world\") (Fact $x) $x)",
    "(let* (($n (+ 1 2)) ($m (* $n 4))) (if (> $m 10) big small))",
    "(collapse (get-atoms &events))",
    "(eval (sread \"(shell \\\"ls\\\")\"))",                    # eval runs the sread once; its result stays data
    "(let $c (sread \"(+ 1 2)\") (eval $c))",
    "(case (car-atom (quote (a b))) ((a 1) ($else 2)))",
    "(trace! \"seen\" (match &persistent (Note $x) $x))",          # stream operations PeTTa rewrites, in its shapes
    "(unique (match &persistent (Note $x) $x))",
    "(union (superpose (1 2)) (superpose (2 3)))",
    "(add-atom (space-handle persistent) (Note 1))",               # a memory space named by its alias
    "(let (\"tag\" $h) (quote (\"tag\" \"persistent\")) (add-atom (space-handle $h) (Note 1)))",  # data binds by position
    "(let $h (prog1 \"persistent\" \"skills\") (add-atom (space-handle $h) (Note 1)))",   # prog1's first value
])
def test_metta_that_stays_in_the_minds_memory_spaces_runs_without_asking(expression):
    assert reach(f'(metta "{_escaped(expression)}")') == metta_reach.Reach(())


@pytest.mark.parametrize("expression,why", [
    ("(match &persistent (Note $x) (shell $x))", "uses shell"),          # a template's calls run
    ("(match &persistent (Note $x) (Wrap (shell $x)))", "uses shell"),   # also inside data
    ("(Data (shell \"x\"))", "uses shell"),                              # an unknown head's arguments run
    ("(match &persistent (Fn $f) ($f 1))", "calls whatever $f holds"),
    ("(match &persistent (Cmd $c) (eval $c))", "evaluates an atom the gate cannot see"),
    ("(let $c (sread \"(shell \\\"ls\\\")\") (eval $c))", "uses shell"),
    ("(add-atom &persistent (= (f) (shell \"x\")))", "function definition"),   # code in any space is code
    ("(remove-atom &beliefs (= (guard) 1))", "function definition"),
    ("(add-atom &persistent (: f (-> Atom Atom)))", "type declaration"),
    ("(add-atom &persistent $x)", "cannot see"),
    ("(add-atom &self (Note 1))", "&self"),
    ("(add-atom (new-space) (Note 1))", "new-space"),
    ("(py-call (os.system \"ls\"))", "calls Python (os.system)"),
    ("(import! &self ./x.metta)", "import!"),
    ("(translatePredicate (shell \"ls\"))", "Prolog predicate shell"),
    ("(change-state! &cycle 0)", "runtime state"),
    ("(match &persistent (Note $x) (Found $x))", "uses Found"),          # an unknown head could be a function
    ("(forall (gen) (test))", "chosen when it runs"),
    ("(let $f quote ($f (shell \"x\")))", "uses shell"),                # a variable head's arguments run first
    ("(reduce (quote (shell \"x\")))", "uses shell"),                    # reduce calls its head as a function
    ("(let $f eval ($f (quote (shell \"x\"))))", "uses eval"),
    # A variable head is never one of PeTTa's stream operations, whatever its name, and PeTTa rewrites unique only
    # with one argument and union only over two superpose lists, so each of these calls a function (#335's lens).
    ("(let $unique py-call ($unique (os.system \"ls\")))", "uses py-call"),
    ("(let $trace! add-atom ($trace! &self (quote (= (f) 1))))", "uses add-atom"),
    ("(unique 1 2)", "uses unique"),
    ("(union (a) (b))", "uses union"),
    # The registry holds other spaces beside the memory spaces: skills, the skill directory, and attention.
    ("(add-atom (space-handle \"skills\") (Injected 1))", "cannot tell"),
    ("(add-atom (space-handle skills) (Injected 1))", "cannot tell"),
    ("(match (space-handle \"attention\") (Focus $x) $x)", "cannot tell"),
    # A let or case pattern runs a call in it before the value is matched, cons-atom here in reverse, so its variables
    # get the atoms PeTTa gives them, not the ones in their positions (Jon's review of ed87db6b).
    ("(let (cons-atom $f $t) (quote (py-call + q)) ($f (quote (os.system \"touch x\"))))", "calls whatever $f holds"),
    ("(let* (((cons-atom $f $t) (quote (py-call + q)))) ($f (quote (os.system \"x\"))))", "calls whatever $f holds"),
    ("(case (quote (py-call + q)) (((cons-atom $f $t) ($f (quote (os.system \"x\"))))))", "calls whatever $f holds"),
    ("(case (quote (py-call + q)) (((cons $f $t) ($f (quote (os.system \"x\"))))))", "calls whatever $f holds"),
    ("(let (cons-atom $h $t) (quote (\"skills\" \"persistent\" \"q\")) (add-atom (space-handle $h) (Mark x)))",
     "cannot tell"),
    # A form's value is PeTTa's, or unknown: prog1's is its first argument's, catch's is left unknown, quote puts in
    # bound variables, and a variable is one across the whole command (Jon's review of a4105a41).
    ("(let $f (prog1 (quote py-call) (quote +)) ($f (quote (os.system \"touch x\"))))", "uses py-call"),
    ("(let $h (prog1 \"skills\" \"persistent\") (add-atom (space-handle $h) (Mark x)))", "cannot tell"),
    ("(let $x (prog1 (quote (= (f) 1)) (quote (Note a))) (add-atom &persistent $x))", "function definition"),
    ("(let $f (and-then True (quote py-call)) ($f 1))", "uses py-call"),
    ("(let $f (or-else False (quote py-call)) ($f 1))", "uses py-call"),
    ("(let $f (catch (quote +)) ($f 1))", "calls whatever $f holds"),
    ("(let $x (quote (= (f) 1)) (let $y (quote $x) (add-atom &persistent $y)))", "function definition"),
    ("(progn (let $x (quote (shell \"x\")) 0) (eval $x))", "cannot see"),
])
def test_metta_reaching_past_the_memory_spaces_or_out_of_sight_asks(expression, why):
    found = reach(f'(metta "{_escaped(expression)}")')
    assert not found.own and any(why in reason for reason in found.asks), found.asks


@pytest.mark.parametrize("command", [
    '(metta "(match shell (\\"id\\") ok)")',
    '(match shell ("id") ok)',
    '(match (quote shell) ("id") ok)',
    '(let $s shell (match $s ("id") ok))',
    '(match open ("/etc/passwd" write $s) ok)',
    '(match delete_file ("/tmp/x") ok)',
    '(get-atoms py_call)',
    '(metta "(get-atoms py_call)")',
    '(match &kb (Note $x) $x)',     # a handle the gate cannot tell is a memory space
    '(match 42 (Note $x) $x)',      # a literal
    '(match $u (Note $x) $x)',      # a value the gate cannot see
])
def test_match_and_get_atoms_on_anything_but_the_minds_spaces_ask(command):
    """PeTTa's match and get-atoms call their first argument as a Prolog predicate (src/spaces.pl:63), so a symbol in
    that place runs it, shell/1 and open/4 included: the inputs a review of the gate found running without asking."""
    found = reach(command)
    assert not found.own and any("Prolog predicate" in reason for reason in found.asks), found.asks


@pytest.mark.parametrize("command", ["(metta \"(match &self (Config $x) $x)\")", "(get-atoms &self)"])
def test_reading_self_through_match_or_get_atoms_asks(command):
    """&self holds the mind's code and setup, and in PeTTa a (get-atoms &self) makes a later bare function name run
    that function (the seeded PeTTa run below found it), so reading &self asks as writing it does."""
    found = reach(command)
    assert not found.own and any("&self" in reason for reason in found.asks), found.asks


# ---- the memory skills ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("command", [
    '(space-merge-atoms "persistent" "(Old $x)" "(New $x)" "dedupe")',
    '(persistent-merge-atoms "(Old $x)" "(New $x)" "dedupe")',
    '(retire-persistent-expression "(Note \\"x\\")" "stale")',
    '(space-transform "events" "(Old $x)" "persistent" "(New $x)" "move")',
    '(space-transform "events | (Old $x) | persistent | (New $x) | move")',
    '(persistent-cleanup-commit "p-1")',
    '(persistent-expression "(Note \\"keep this\\")")',
    '(space-merge-atoms persistent "(Old $x)" "(New $x)" "dedupe")',   # a memory space named by its alias
])
def test_merging_moving_or_retiring_a_minds_own_atoms_runs_without_asking(command):
    assert reach(command).own


@pytest.mark.parametrize("command,why", [
    ('(persistent-merge-atoms "(= (shell $x) (rm))" "(Note x)" "sneak")', "function definition"),
    ('(space-merge-atoms "persistent" "(Old $x)" "(= (f) (shell \\"x\\"))" "sneak")', "function definition"),
    ('(retire-persistent-expression "$x" "everything")', "cannot see"),
    ('(retire-persistent-expression "($h 1)" "any head")', "head the gate cannot see"),
    ('(space-transform "events | (= $f $b) | persistent | (Old $f) | move")', "function definition"),
    ('(space-transform "events | (Old $x) | persistent")', "spec the gate cannot read"),
    ('(retire-persistent-expression "\x0c(= (f) 1)" "hidden")', "cannot read"),
    ('(persistent-expression "(= (greet) (shell \\"x\\"))")', "function definition"),
    ('(run-metta-file "memory/x.metta")', "run-metta-file"),     # loading a file from disk asks
    # a space name outside the memory spaces, such as skills, the skill directory (#335's lens)
    ('(space-merge-atoms "skills" "(SkillTopic $s \\"memory\\")" "(SkillTopic $s \\"x\\")" "retopic")', "cannot tell"),
    ('(space-transform "persistent" "(Note $x)" "skills" "(Injected $x)" "move")', "cannot tell"),
    ('(space-transform "attention | (Focus $x) | persistent | (Note $x) | move")', "cannot tell"),
    ('(let (cons-atom $h $t) (quote ("skills" "persistent" "q")) (space-merge-atoms $h "(SkillTopic $s $x)" "(Mark x)" '
     '"r"))', "cannot tell"),
    ('(let $h (prog1 "skills" "persistent") (space-merge-atoms $h "(SkillTopic $s $x)" "(Mark x)" "r"))', "cannot tell"),
])
def test_a_memory_skill_that_would_change_code_or_reach_a_file_asks(command, why):
    found = reach(command)
    assert not found.own and any(why in reason for reason in found.asks), found.asks


# ---- the policy gate ------------------------------------------------------------------------------------------------------

def test_a_minds_own_atom_merge_runs_without_asking_and_shows_in_the_decision_history(client):
    _, (a, _) = make_swarm_and_agents(client)
    command = '(space-merge-atoms "persistent" "(Old $x)" "(New $x)" "dedupe")'
    assert authorize(client, a, command)["decision"] == "allow"
    assert authorize(client, a, command)["decision"] == "allow"
    rows = client.get("/api/approvals", params={"status": "auto"}).json()
    assert [(r["agent_id"], r["skill"], r["command"], r["reason"]) for r in rows] == \
        [(a["id"], "space-merge-atoms", command, policy.RAN_WITHOUT_ASKING)]   # one row however often it runs
    assert client.get("/api/approvals", params={"status": "pending"}).json() == []


def test_loading_a_metta_file_from_disk_asks_and_says_why(client):
    _, (a, _) = make_swarm_and_agents(client)
    pending = authorize(client, a, '(run-metta-file "memory/x.metta")')
    assert pending["decision"] == "pending" and "reaches past the mind's own memory spaces" in pending["message"]
    row = client.get("/api/approvals", params={"status": "pending"}).json()[0]
    assert row["risk"] == "high" and "run-metta-file" in row["reason"]


def test_metta_on_memory_runs_and_metta_calling_python_asks(client):
    _, (a, _) = make_swarm_and_agents(client)
    assert authorize(client, a, '(metta "(add-atom &persistent (Note \\"hi\\"))")')["decision"] == "allow"
    pending = authorize(client, a, '(metta "(py-call (os.system \\"ls\\"))")')
    assert pending["decision"] == "pending" and "calls Python (os.system)" in pending["message"]
    once = decide(client, pending["approval_id"], "always")
    assert once.status_code == 400 and once.json()["error"]["code"] == "one_at_a_time"


def test_a_person_can_make_a_minds_own_memory_metta_ask(client):
    _, (a, b) = make_swarm_and_agents(client)
    command = '(metta "(match &persistent (Note $x) $x)")'
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "metta", "mode": "ask", "note": "ask me"})
    assert authorize(client, a, command)["decision"] == "pending"
    assert authorize(client, b, command)["decision"] == "allow"            # only that mind


def test_a_name_alone_asks_since_the_gate_sees_no_command(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    for skill in policy.REACH_DECIDED:
        assert hive.policy.decide(hive.agent(a["id"]), skill)[0] == "ask", skill


def test_ran_without_asking_rows_never_push_a_persons_decisions_out_of_the_history(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.db.insert("approvals", {"id": "p_decided1", "agent_id": a["id"], "skill": "shell-confirm",
                                 "command": '(shell-confirm "ls")', "reason": "x", "risk": "high", "status": "denied",
                                 "decided_by": "user:operator", "created_at": "2026-01-01T00:00:00Z",
                                 "decided_at": "2026-01-01T00:00:01Z"})
    for i in range(510):
        hive.db.insert("approvals", {"id": f"p_auto{i:04d}", "agent_id": a["id"], "skill": "metta",
                                     "command": f"(metta \"(+ {i} 1)\")", "reason": policy.RAN_WITHOUT_ASKING,
                                     "risk": "low", "status": "auto", "decided_by": "policy",
                                     "created_at": f"2026-11-13T00:{i // 60:02d}:{i % 60:02d}Z", "decided_at": None})
    ids = {row["id"] for row in hive.policy.approvals()}
    assert "p_decided1" in ids and sum(i.startswith("p_auto") for i in ids) == 500


def test_a_ran_without_asking_row_cannot_be_answered(client):
    _, (a, _) = make_swarm_and_agents(client)
    authorize(client, a, '(metta "(get-atoms &persistent)")')
    row = client.get("/api/approvals", params={"status": "auto"}).json()[0]
    answer = decide(client, row["id"], "once")
    assert answer.status_code == 409 and answer.json()["error"]["code"] == "not_pending"


# ---- the tables, derived from the shipped MeTTa -----------------------------------------------------------------------------

def _strip(text):
    """PeTTa's file reader (src/filereader.pl strip/3): a ; outside a string drops the rest of its line."""
    out, inside, i = [], False, 0
    while i < len(text):
        if text[i] == '"':
            inside = not inside
        elif text[i] == ";" and not inside:
            i = text.find("\n", i)
            if i < 0:
                break
        out.append(text[i])
        i += 1
    return "".join(out)


def _forms(path):
    """A .metta file's top-level forms as PeTTa's file reader splits them: (runnable, expression)."""
    text, forms, i = _strip(path.read_text(encoding="utf-8")), [], 0
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            return forms
        runnable = text[i] == "!"
        i += runnable
        depth, inside, j = 0, False, i
        while j < len(text):
            inside ^= text[j] == '"'
            depth += (not inside) * ((text[j] == "(") - (text[j] == ")"))
            j += 1
            if depth == 0 and not inside:
                break
        forms.append((runnable, read(text[i:j])))
        i = j


def _shipped():
    forms = [form for path in sorted(EXTENSIONS.glob("*.metta")) for form in _forms(path)]
    equations = {}
    for runnable, form in forms:
        if not runnable and isinstance(form, tuple) and len(form) == 3 and form[0] == "=" and isinstance(form[1], tuple):
            equations.setdefault((str(form[1][0]), len(form[1]) - 1), []).append(form)
    return forms, equations


def _render(value):
    if isinstance(value, tuple):
        return "(" + " ".join(map(_render, value)) + ")"
    if isinstance(value, Var):
        return "$" + value
    if isinstance(value, Str):
        return json.dumps(str(value))
    return str(value)


def _heads(value):
    if isinstance(value, tuple) and value:
        if isinstance(value[0], Sym):
            yield str(value[0]), len(value) - 1
        for item in value:
            yield from _heads(item)


def test_the_memory_spaces_are_those_the_runtime_registers_with_role_memory():
    _, equations = _shipped()
    (body,) = [form[2] for form in equations[("register-default-runtime-spaces", 0)]]
    calls = [call for call in body[1:] if isinstance(call, tuple)]
    registered = {str(c[1]): str(c[2]) for c in calls if c[:1] == (Sym("register-space"),) and c[3] == Sym("memory")}
    aliases = {str(c[1]): c[2] for c in calls if c[:1] == (Sym("register-space-alias"),) and isinstance(c[1], Sym)}
    assert registered == metta_reach.MEMORY_REGISTRY
    assert metta_reach.MEMORY_SPACES == set(registered.values())
    # each name is also an alias spelled the same, so the gate reads it as its space as a string or as a symbol
    assert {name: typed(aliases.get(name)) for name in registered} == {name: typed(Str(name)) for name in registered}


def test_no_other_shipped_registration_takes_a_memory_spaces_name():
    """The gate reads a memory space's name as that space wherever a mind writes it, so no extension or module may
    register the name, or an alias spelled the same, for another space or role (#335's lens: the registry also holds
    skills, the skill directory, with role affordance, and attention with role immune)."""
    paths = sorted(EXTENSIONS.glob("*.metta")) + sorted((ROOT / "modules").rglob("*.metta"))
    seen = 0
    for path in paths:
        for _, form in _forms(path):
            for call in _walk_items(form):
                if len(call) < 3 or not isinstance(call[1], (Str, Sym)) or call[1] not in metta_reach.MEMORY_REGISTRY:
                    continue
                if call[0] == Sym("register-space"):
                    seen += 1
                    assert typed(call[2:]) == typed((Sym(metta_reach.MEMORY_REGISTRY[call[1]]), Sym("memory"))), \
                        (path.name, call)
                elif call[0] == Sym("register-space-alias"):
                    seen += 1
                    assert typed(call[2:]) == typed((Str(call[1]),)), (path.name, call)
    assert seen >= 2 * len(metta_reach.MEMORY_REGISTRY)


def test_each_memory_skills_arguments_are_those_its_skill_args_type_metta_or_space():
    forms, equations = _shipped()
    declared = {}
    for runnable, form in forms:
        if runnable and form[:1] == (Sym("add-atom"),) and isinstance(form[2], tuple) and form[2][:1] == (Sym("SkillArg"),):
            _, skill, position, kind, _ = form[2]
            declared.setdefault(str(skill), {})[position - 1] = str(kind)
    for (name, arity), args in metta_reach.MEMORY_SKILLS.items():
        if name in declared and len(declared[name]) == arity:
            kinds = declared[name]
            assert args == metta_reach.SkillArgs(metta=tuple(i for i in sorted(kinds) if kinds[i] == "metta"),
                                                 space=tuple(i for i in sorted(kinds) if kinds[i] == "space")), name
        else:   # space-transform's five-argument form, which no SkillArg describes
            (equation,) = equations[(name, arity)]
            assert args == _arguments_used(equation[1][1:], equation[2]), name
    # The one-argument form's spec, split as the runtime splits it, holds the five-argument form's parameters in order.
    assert declared["space-transform"] == {0: "rest-text"} and metta_reach.SPEC_SKILL == ("space-transform", 1)
    (spec_form,) = equations[metta_reach.SPEC_SKILL]
    (parts,) = [item for item in _walk_items(spec_form[2])
                if item[:1] == (Sym("SpaceTransformSpec"),) and len(item) == 6]
    assert metta_reach.SPEC_ARGS == _arguments_used(parts[1:], spec_form[2])


def _arguments_used(params, body):
    """Which of params body reads with sread (MeTTa atoms) and which it resolves with space-known or space-handle."""
    calls = list(_walk_items(body))
    def used(*heads):
        names = {call[1] for call in calls if call[:1] in {(Sym(h),) for h in heads} and len(call) == 2}
        return tuple(i for i, p in enumerate(params) if p in names)
    return metta_reach.SkillArgs(metta=used("sread"), space=used("space-known", "space-handle"))


def _walk_items(value):
    if isinstance(value, tuple):
        yield value
        for item in value:
            yield from _walk_items(item)


# The reviewed memory skills' definitions with every hive function they call: a change to any of them fails here until
# someone reviews again that it touches only the mind's memory spaces and their files, and updates its hash. Reviewed
# for #76: their only calls past the spaces are export!'s hive_helpers.save_atoms, which writes the space's own file as
# the registry names it (memory-file, in the mind's memory folder), and space-transform's
# one-argument form's hive_helpers.space_transform_spec_atom, which only parses its spec, and persistent-expression's
# hive_helpers.persistent_expression_atom, which only checks its expression's syntax. Reviewed again for #335's lens:
# persistent-cleanup-commit now refuses, before it removes or writes anything, a stored atom that is or could be code
# (cleanup-code-atom?, which only inspects its argument; its rule is the gate's, checked in PeTTa below). Reviewed again
# for main's 6cbc5cc5 (an idle mind writes nothing to disk): export! now gives save_atoms the atoms' repr texts, which it
# writes to that same file only when they differ from it, through a .saving file beside it renamed over it, where
# append-file, save_begin and save_commit wrote the same bytes every time.
REVIEWED = {
    "space-merge-atoms/4": "d3490245277556193b107346254bd6914653b9281a87d9cbc1ca53de2de9eec8",
    "persistent-merge-atoms/3": "4d34b45ea3cf20e020d77d986d48d4721460b3d5d12b14016563a7209547c8c5",
    "retire-persistent-expression/2": "9623c1ebb32f3bf49c6f22849f6c1f6a173867f3f140fa2825a3e31775f7d123",
    "space-transform/5": "5f3e397391219a7e968c624424304d4d20968165486bb47a51e8c77c9f1e00e1",
    "space-transform/1": "9198001e0d1ef1faa5217b7ed90864ff384d95f7696cbc2e35c376ccacc2fb2e",
    "persistent-cleanup-commit/1": "a6842f080b00e83aaf5823ba3168ef67bee745e13a5e0da3f9b4c7f1b88b61b3",
    "persistent-expression/1": "4c9c5198bcf72abee0eab5051d41bc25ff5a725930a2cc4ef94fe87a3df78f91",
}


def _closure(equations, name, arity):
    seen, todo = set(), [(name, arity)]
    while todo:
        key = todo.pop()
        if key in seen or key not in equations:
            continue
        seen.add(key)
        for form in equations[key]:
            todo.extend(_heads(form[2]))
    return sorted(seen)


def reviewed_hashes():
    _, equations = _shipped()
    out = {}
    for key in REVIEWED:
        name, arity = key.rsplit("/", 1)
        text = "\n".join(_render(form) for k in _closure(equations, name, int(arity)) for form in equations[k])
        out[key] = hashlib.sha256(text.encode()).hexdigest()
    return out


def test_the_reviewed_memory_skills_are_the_definitions_that_were_reviewed():
    assert reviewed_hashes() == REVIEWED
    assert {f"{n}/{a}" for n, a in [*metta_reach.MEMORY_SKILLS, metta_reach.SPEC_SKILL]} == set(REVIEWED)


@pytest.mark.parametrize("spec", ["events | (Old $x) | persistent | (New $x) | move", " a|b|c|d|e ", "a | b | c | d",
                                  "a | | c | d | e", "a | b | c | d | e | f"])
def test_the_gate_splits_a_transform_spec_as_the_runtime_does(spec):
    from hive.runtime.extensions.helper_metta import space_transform_spec_atom
    parsed = space_transform_spec_atom(spec)
    parts = metta_reach.transform_spec_parts(spec)
    if parts is None:
        assert parsed.startswith("(SpaceTransformSpecError")
    else:
        assert read(parsed)[1:] == tuple(Str(p) for p in parts)


def test_the_metta_skill_is_the_one_omega_defines():
    skills = ROOT / "third_party" / "Omega" / "src" / "skills.metta"
    if not skills.exists():
        pytest.skip("third_party/Omega is not checked out")
    (definition,) = [form for runnable, form in _forms(skills) if not runnable and form[:2] == (Sym("="), (Sym("metta"), Var("str")))]
    assert definition == read("(= (metta $str) (let $code (sread $str) (repr (swrite (eval $code)))))")


@needs_petta
def test_every_builtin_the_gate_names_is_one_petta_registers():
    text = (PETTA / "src" / "metta.pl").read_text()
    start = text.index(":- maplist(register_fun, [")
    names = text[start:text.index("]).", start)].split("[", 1)[1].replace("\n", " ").split(",")
    registered = {name.strip().strip("'").replace("\\\\", "\\") for name in names}   # '#\\=' in Prolog is #\=
    named = metta_reach.SAFE_BUILTINS | set(metta_reach.ASKING_BUILTINS)
    # swrite is no PeTTa builtin: Omega imports it from Prolog (src/skills.metta's import_prolog_functions_from_file)
    assert named - registered == {"swrite"}, sorted(named - registered)


# ---- soundness against PeTTa itself -----------------------------------------------------------------------------------------

def _petta(program, tmp_path):
    path = tmp_path / "probe.metta"
    path.write_text(program)
    run = subprocess.run(["sh", str(PETTA / "run.sh"), str(path), "--silent"], cwd=PETTA, capture_output=True, text=True)
    return run.stdout + run.stderr


# superpose is left out: called when it runs on an unbound variable, PeTTa's member/2 enumerates lists until the stack
# is gone, which says nothing about reach.
FORM_NAMES = ["quote", "eval", "collapse", "repr", "let", "catch", "once", "progn", "canary", "car-atom"]
# What match and get-atoms read: a memory space and &self, and what PeTTa would call as a predicate instead, the canary
# by name, quoted or through a variable; a ($r) pattern makes (match canary ($r) ...) a call of canary/1.
SPACE_ARGS = ["&persistent", "&self", "canary", "(quote canary)", "$f", "$c"]
# What let and case match against: variables and data, and patterns with a call in them, which PeTTa runs before the
# value is matched, cons-atom in reverse; with (quote (canary + 1)) the call gives $f canary where position gives +.
PATTERNS = ["$c", "$f", "(Note $c)", "($x $c)", "(cons-atom $f $c)", "(cons $f $c)", "(\"s\" (cons-atom $f $c))"]
PATTERN_VALUES = ["(quote (canary + 1))", "(quote (\"s\" (canary + 1)))"]
# Conditions for if, and-then and or-else: the symbols true and false, and atoms PeTTa takes as not true since they
# are not the symbol true (src/translator.pl:183), the string "true", a variable read from "$true", and x.
CONDITIONS = ["True", "False", '"true"', '(sread "$true")', "x"]
# Atoms a computed value may be, one the gate must not mistake and one it may let through, for a head, a space, an atom
# written (Jon's review of a4105a41) and an atom evaluated, the last pair one text in two kinds (a check of 3924fc40): a
# form whose value the gate gets wrong shows as a call of the canary, a write into &sentinel, which is no memory space,
# or a definition of (fresh).
VALUE_PROBES = {"head": ("(quote canary)", "(quote +)"), "space": ("&sentinel", "&persistent"),
                "atom": ("(quote (= (fresh) DEFINED))", "(quote (Note a))"),
                "eval": ("(quote (canary))", "(quote (\"canary\"))")}


def _value_probes(rng, n):
    """n values of each kind, put where a wrong one would show: called, written into, written, evaluated. Half come
    after (sread "$t") made $v a fresh variable that a pattern then binds to true, or leaves unbound, with $v as every
    condition: PeTTa tests a condition only when the branch runs, so a variable bound by then decides it (a check of
    0f4b648d)."""
    uses = {"head": "(let $f {} ($f))", "space": "(let $s {} (add-atom $s (Mark)))",
            "atom": "(let $d {} (add-atom &persistent $d))", "eval": "(let $c {} (eval $c))"}
    probes = set()
    for kind, use in uses.items():
        for _ in range(n):
            if rng.random() < 0.5:
                probes.add(use.format(_value(rng, *VALUE_PROBES[kind])))
            else:
                value = use.format(_value(rng, *VALUE_PROBES[kind], conditions=["$v"]))
                probes.add(f"(let $v (sread \"$t\") (progn {rng.choice(BINDERS)} {value}))")
    return probes


# What may bind $v, a variable sread made, before a later condition reads it: a let pattern, a case pattern, or nothing.
BINDERS = ["(let true $v 0)", "(case true (($v 0)))", "0"]


def _value(rng, bad, ok, depth=0, conditions=CONDITIONS):
    """A value computed by a form around bad and ok, one the gate models (VALUE_FORMS) or one it leaves unknown, its
    arguments mostly the two atoms themselves, so a form whose value the gate gets wrong turns up often."""
    def v():
        if depth < 1 and rng.random() < 0.4:
            return _value(rng, bad, ok, depth + 1, conditions)
        return rng.choice([bad, ok])
    b = lambda: rng.choice(conditions)     # noqa: E731
    return rng.choice([
        lambda: f"(prog1 {v()} {v()})", lambda: f"(progn {v()} {v()})", lambda: f"(and-then {b()} {v()})",
        lambda: f"(or-else {b()} {v()})", lambda: f"(if {b()} {v()} {v()})", lambda: f"(case 1 ((1 {v()}) ($else {v()})))",
        lambda: f"(once {v()})", lambda: f"(catch {v()})", lambda: f"(collapse {v()})", lambda: f"(transaction {v()})",
        lambda: f"(with_mutex m {v()})", lambda: f"(sealed ($c) {v()})", lambda: f"(let $c {v()} $c)",
        lambda: f"(let* (($c {v()})) $c)", lambda: f"(chain $c {v()} $c)", lambda: f"(unique {v()})",
        lambda: f"(superpose ({v()} {v()}))", lambda: rng.choice([bad, ok]),
    ])()


def _expressions(rng, depth=0):
    """Random MeTTa over reads and writes of the mind's memory, reads of &self and of what PeTTa would call as a
    predicate instead (SPACE_ARGS), every form the gate models, quoted, parsed and stored calls of a canary, and variable
    heads bound to form names, some named like PeTTa's stream operations, let and case patterns with calls in them
    (PATTERNS), conditions of every kind (CONDITIONS), and values forms compute in a head, as a space, as an atom
    written or evaluated (VALUE_PROBES), so the gate's verdicts cover every position PeTTa does or does not run.
    Nothing it makes can loop: superpose, hyperpose and the list forms only ever get a literal list."""
    leaf = ["1", "\"s\"", "Note", "canary", "$c", "$f", "$x", "(canary)", "(quote (canary))", "(sread \"(canary)\")",
            "(+ 1 2)", "&persistent", "(quote (canary + 1))"]
    if depth > 3:
        return rng.choice(leaf)
    sub = lambda: _expressions(rng, depth + 1)   # noqa: E731
    form = lambda: rng.choice(FORM_NAMES)   # noqa: E731
    forms = [
        lambda: f"(quote {sub()})",
        lambda: f"(let {rng.choice(PATTERNS)} {sub()} {sub()})",
        lambda: f"(let {rng.choice(PATTERNS)} {rng.choice(PATTERN_VALUES + [sub()])} ($f))",
        lambda: f"(chain {sub()} $c {sub()})",
        lambda: f"(let* (($c {sub()}) ($f {sub()})) {sub()})",
        lambda: f"(if {rng.choice(CONDITIONS)} {sub()} {sub()})",
        lambda: f"(case {sub()} ((1 {sub()}) ({rng.choice(PATTERNS)} {sub()}) ($else {sub()})))",
        lambda: f"(case {rng.choice(PATTERN_VALUES + [sub()])} (({rng.choice(PATTERNS)} ($f))))",
        lambda: f"(match {rng.choice(SPACE_ARGS)} {rng.choice(['(Cmd $c)', '(Fn $f)', '$x', '($r)'])} {sub()})",
        lambda: f"(get-atoms {rng.choice(SPACE_ARGS)})",
        lambda: f"(collapse {sub()})",
        lambda: f"(superpose ({sub()} {sub()}))",
        lambda: f"(hyperpose ({sub()} {sub()}))",
        lambda: f"(add-atom {rng.choice(['&persistent', '&self'])} {rng.choice(['(Note ' + sub() + ')', '$c', '(= (g) (canary))'])})",
        lambda: f"(remove-atom &persistent (Note {sub()}))",
        lambda: f"(eval {sub()})",
        lambda: f"(reduce ({form()} {sub()}))",
        lambda: f"(catch {sub()})",
        lambda: f"(once {sub()})",
        lambda: f"(progn {sub()} {sub()})",
        lambda: f"(prog1 {sub()} {sub()})",
        lambda: f"(and-then {rng.choice(CONDITIONS)} {sub()})",
        lambda: f"(sealed ($c) {sub()})",
        lambda: f"(map-atom (1 2) $x {sub()})",
        lambda: f"(filter-atom (1 2) $x {sub()})",
        lambda: f"(foldl-atom (1 2) 0 $a $x {sub()})",
        lambda: f"((|-> ($x) {sub()}) 1)",
        lambda: f"(Wrap {sub()})",
        lambda: f"($f {sub()})",
        lambda: f"(let $f {form()} ($f {sub()}))",
        lambda: f"(let $unique {form()} ($unique {sub()}))",
        lambda: f"(let $trace! {form()} ($trace! {sub()} {sub()}))",
        lambda: f"(let $f {_value(rng, *VALUE_PROBES['head'])} ($f))",
        lambda: f"(let $s {_value(rng, *VALUE_PROBES['space'])} (add-atom $s (Mark)))",
        lambda: f"(let $d {_value(rng, *VALUE_PROBES['atom'])} (add-atom &persistent $d))",
        lambda: f"(let $c {_value(rng, *VALUE_PROBES['eval'])} (eval $c))",
        lambda: f"(repr {sub()})",
        lambda: f"(cons-atom {sub()} ())",
        lambda: rng.choice(leaf),
    ]
    return rng.choice(forms)()


@needs_petta
def test_petta_never_does_what_the_gate_let_through(tmp_path):
    """The gate's model checked against PeTTa: of seeded random expressions, those it lets run never call the canary,
    write into &sentinel or define (fresh) when PeTTa runs them, over a memory space holding a stored call (Cmd (canary))
    and a stored name (Fn canary)."""
    rng = random.Random(76)
    expressions = sorted({_expressions(rng) for _ in range(1500)} | _value_probes(rng, 300))
    own = [e for e in expressions if reach(f'(metta "{_escaped(e)}")').own]
    asking = [e for e in expressions if e not in own]
    assert len(own) >= 50 and len(asking) >= 50, (len(own), len(asking))
    prelude = ("(= (canary) (println! \"CANARY-RAN\"))\n!(bind! &persistent (new-space))\n"
               "!(add-atom &persistent (Cmd (canary)))\n!(add-atom &persistent (Fn canary))\n")
    assert _violations(prelude, own, tmp_path) == {"call": [], "write": [], "define": []}
    # each oracle fires, so its silence above means something
    controls = ["(canary)", "(add-atom &sentinel (Mark))", "(add-atom &persistent (= (fresh) DEFINED))"]
    assert _violations(prelude, controls, tmp_path) == {"call": controls[:1], "write": controls[1:2], "define": controls[2:]}


def _violations(prelude, expressions, tmp_path):
    """What each expression does in PeTTa after prelude that the gate must have asked about: call the canary, write into
    &sentinel, a space no mind remembers in, or define (fresh), renamed (fresh<i>) for expression i so each is told apart.
    Each runs caught, so an error stops nothing, and marked by an EXPR-i line before it.

    Time: one PeTTa run over all of them."""
    body = "".join(f"!(println! \"EXPR-{i}\")\n!(catch {e.replace('(fresh)', f'(fresh{i})')})\n"
                   f"!(println! (AFTER {i} (size-atom (collapse (get-atoms &sentinel))) (fresh{i})))\n"
                   for i, e in enumerate(expressions))
    out = _petta("!(bind! &sentinel (new-space))\n" + prelude + "!(println! \"BEGIN\")\n" + body
                 + "!(println! \"END\")\n", tmp_path)
    assert "BEGIN" in out and "END" in out, out[-2000:]
    found, current, written = {"call": [], "write": [], "define": []}, None, 0
    for line in out.splitlines():
        after = re.match(r"\(AFTER (\d+) (\d+) (.*)\)$", line.strip())
        if line.startswith('"EXPR-'):
            current = expressions[int(line.strip('"')[5:])]
        elif "CANARY-RAN" in line and current not in found["call"]:
            found["call"].append(current)
        elif after:
            if int(after[2]) > written:
                found["write"].append(expressions[int(after[1])])
                written = int(after[2])
            if after[3] == "DEFINED":
                found["define"].append(expressions[int(after[1])])
    return found


def _canary_runs(prelude, expressions, tmp_path):
    """The expressions that call the canary when PeTTa runs them (_violations)."""
    return _violations(prelude, expressions, tmp_path)["call"]

# Each form whose value the gate models (VALUE_FORMS) with expressions its value is checked on, and the forms whose
# value it leaves unknown: every form the gate reads is one or the other, so a new form has to be placed.
VALUE_SAMPLES = {
    "quote": ["(quote (a b))", "(let $x 5 (quote (a $x)))", "(let $x (quote py-call) (quote ($x 1)))"],
    "let": ["(let $x 1 (quote body))", "(let (\"t\" $h) (quote (\"t\" p)) (quote $h))"],
    "chain": ["(chain $x (quote v) (quote w))"],
    "let*": ["(let* (($x 1) ($y (quote b))) (quote ($x $y)))"],
    "if": ["(if True (quote a) (quote b))", "(if False (quote a) (quote b))", "(if True (quote a))",
           "(if \"true\" (quote a) (quote b))", "(if x (quote a) (quote b))"],
    "case": ["(case 1 ((1 (quote a)) ($else (quote a))))"],
    "progn": ["(progn (quote a) (quote b))"],
    "prog1": ["(prog1 (quote a) (quote b))", "(prog1 (quote py-call) (quote +))"],
    "and-then": ["(and-then True (quote b))", "(and-then False (quote b))", "(and-then x (quote b))",
                 "(and-then \"true\" (quote b))"],
    "or-else": ["(or-else True (quote b))", "(or-else False (quote b))", "(or-else x (quote b))",
                "(or-else \"true\" (quote b))"],
    "once": ["(once (quote a))"],
    "transaction": ["(transaction (quote a))"],
    "with_mutex": ["(with_mutex m (quote a))"],
    "sealed": ["(sealed ($x) (quote a))"],
    "add-atom": ["(add-atom &s (A))"],
    "remove-atom": ["(remove-atom &s (A))"],
    "cut": ["(cut)"],
    "reduce": ["(reduce (sread \"(a b)\"))"],
}
UNKNOWN_FORMS = {"match", "eval", "call", "translatePredicate", "py-call", "superpose", "hyperpose", "catch", "collapse",
                 "test", "forall", "foldall", "foldl-atom", "map-atom", "filter-atom", "|->"}


def test_every_form_has_its_value_modelled_or_left_unknown():
    assert set(VALUE_SAMPLES) == metta_reach.VALUE_FORMS
    assert metta_reach.VALUE_FORMS | UNKNOWN_FORMS == set(metta_reach._FORMS)
    assert not metta_reach.VALUE_FORMS & UNKNOWN_FORMS


@pytest.mark.parametrize("expression", [
    "(if (== 1 2) (quote (\"a\")) (quote (a)))",         # one text in two kinds: a string head and a symbol head
    "(if (== 1 2) 1 1.0)",                               # PeTTa tells 1 from 1.0
    "(if (== 1 2) persistent (sread \"$persistent\"))",  # a symbol and a variable
    "(remove-atom &s (= (f) 1))",                        # false when no such equation was there to erase
    # a condition holding a variable, which a let or case pattern later in the command can bind to true first
    "(if (sread \"$true\") (quote a) (quote b))",
    "(and-then (sread \"$true\") (quote b))",
    "(or-else (sread \"$true\") (quote b))",
])
def test_a_value_the_gate_cannot_pin_is_unknown(expression):
    """Values PeTTa tells apart stay apart, remove-atom's value for an equation depends on the space, and a condition
    holding a variable decides nothing until the test runs."""
    assert metta_reach._Walk().walk(read(expression), {})[1] is metta_reach.UNKNOWN


@needs_petta
def test_each_value_the_gate_models_is_the_one_petta_gives(tmp_path):
    """Jon's review of a4105a41: the gate trusts a form's value only where it is PeTTa's own. Each sample's value is
    known to the gate, and every solution PeTTa gives for it is that value."""
    samples = [e for es in VALUE_SAMPLES.values() for e in es]
    out = _petta("!(bind! &s (new-space))\n!(add-atom &s (A))\n"
                 + "".join(f"!(println! (VAL {i} (collapse {e})))\n" for i, e in enumerate(samples)), tmp_path)
    petta = {int(m[1]): read(m[2]) for m in re.finditer(r"^\(VAL (\d+) (.*)\)$", out, re.M)}
    for i, e in enumerate(samples):
        _, value = metta_reach._Walk().walk(read(e), {})
        assert isinstance(value, metta_reach.Lit), (e, value)
        assert petta.get(i) and all(typed(s) == typed(value.atom) for s in petta[i]), \
            (e, value, petta.get(i), out[-1500:])



@needs_petta
def test_a_variable_named_like_a_stream_operation_calls_what_it_holds_and_asks(tmp_path):
    """#335's lens: PeTTa rewrites trace!, unique and their kin only under an atom head and only in the shapes its rules
    match (src/translator.pl:96-114), so a variable named like one calls the function it holds, and another shape calls
    a function of that name, here a unique/2 a mind defined. Each runs the canary in PeTTa, and the gate asks for each,
    where before it read them as the stream operations and let them run."""
    calls = ["(let $unique eval ($unique (quote (canary))))",
             "(let $alpha-unique eval ($alpha-unique (quote (canary))))",
             "(let $union eval ($union (quote (canary))))",
             "(let $trace! map-atom ($trace! (quote ((canary))) eval))",
             "(unique (quote (canary)) 2)"]
    assert [e for e in calls if reach(f'(metta "{_escaped(e)}")').own] == []
    prelude = "(= (canary) (println! \"CANARY-RAN\"))\n(= (unique $a $b) (eval $a))\n"
    assert _canary_runs(prelude, calls, tmp_path) == calls


@needs_petta
def test_a_pattern_with_a_call_in_it_binds_as_petta_runs_it_and_asks(tmp_path):
    """Jon's review of ed87db6b: PeTTa compiles a let pattern as an expression (src/translator.pl:207) and a case
    pattern through constrain_args (:428), so a call in a pattern runs before the value is matched, cons-atom in
    reverse, and a case's (cons $f $t) splits head from tail. Its variables get what that gives them, not the atoms in
    their positions. Each of these runs the canary in PeTTa where the gate once bound $f to +, and the gate asks."""
    calls = ["(let (cons-atom $f $t) (quote (canary + q)) ($f))",
             "(let* (((cons-atom $f $t) (quote (canary + q)))) ($f))",
             "(case (quote (canary + q)) (((cons-atom $f $t) ($f))))",
             "(case (quote (canary + q)) (((cons $f $t) ($f))))",
             "(let (\"s\" (cons-atom $f $t)) (quote (\"s\" (canary + q))) ($f))"]
    assert [e for e in calls if reach(f'(metta "{_escaped(e)}")').own] == []
    assert _canary_runs("(= (canary) (println! \"CANARY-RAN\"))\n", calls, tmp_path) == calls


@needs_petta
def test_a_value_petta_computes_otherwise_than_the_gate_once_guessed_asks(tmp_path):
    """Jon's review of a4105a41: prog1's value is its first argument's, quote puts in a variable bound by then, and a let
    in one branch of a progn binds for the next, since a PeTTa variable is one across the whole command. Each of these
    calls the canary or defines (fresh) in PeTTa, where the gate once let it through, and the gate asks. The last of
    each kind come from a check of 0f4b648d: a pattern binds a variable sread made to true before a condition reads
    it, so the branch it takes is then's."""
    calls = ["(let $f (prog1 (quote canary) (quote +)) ($f))",
             "(let $x (quote (canary)) (let $y (quote $x) (eval $y)))",
             "(progn (let $x (quote (canary)) 0) (eval $x))",
             "(let $v (sread \"$t\") (progn (let true $v 0) (let $f (if $v (quote canary) (quote +)) ($f))))",
             "(let $v (sread \"$t\") (progn (case true (($v 0))) (let $f (if $v (quote canary) (quote +)) ($f))))"]
    defines = ["(let $x (prog1 (quote (= (fresh) DEFINED)) (quote (Note a))) (add-atom &persistent $x))",
               "(let $x (quote (= (fresh) DEFINED)) (let $y (quote $x) (add-atom &persistent $y)))",
               "(let $v (sread \"$t\") (progn (let true $v 0) "
               "(let $d (and-then $v (quote (= (fresh) DEFINED))) (add-atom &persistent $d))))"]
    assert [e for e in calls + defines if reach(f'(metta "{_escaped(e)}")').own] == []
    found = _violations("(= (canary) (println! \"CANARY-RAN\"))\n!(bind! &persistent (new-space))\n", calls + defines,
                        tmp_path)
    assert found == {"call": calls, "write": [], "define": defines}, found


@needs_petta
def test_an_atom_of_another_kind_or_a_cut_with_arguments_asks_as_petta_runs_it(tmp_path):
    """A check of 3924fc40: PeTTa's if, and-then and or-else take their true branch only on the symbol true
    (src/translator.pl:183, :202, :205), so the string "true" and a variable read from "$true" take the other; two
    values of one text and different kinds stay two; and cut is a form only bare (:139), so with arguments it is a call
    that runs them (:333). Each of these calls the canary, writes into &sentinel or defines (fresh) in PeTTa where the
    gate once let it through, and the gate asks."""
    calls = ['(let $f (if "true" (quote +) (quote canary)) ($f))',
             '(let $c (or-else "true" (quote (canary))) (eval $c))',
             '(let $f (if (sread "$true") (quote +) (quote canary)) ($f))',
             '(let $c (if (== 1 2) (quote ("canary")) (quote (canary))) (eval $c))',
             '(let $c (case 2 ((1 (quote ("canary"))) (2 (quote (canary))))) (eval $c))',
             "(cut (canary))"]
    writes = ['(let $s (if "true" &persistent &sentinel) (add-atom $s (Mark)))', "(cut (add-atom &sentinel (Mark)))"]
    defines = ['(let $d (or-else "true" (quote (= (fresh) DEFINED))) (add-atom &persistent $d))',
               "(cut (add-atom &persistent (= (fresh) DEFINED)))"]
    assert [e for e in calls + writes + defines if reach(f'(metta "{_escaped(e)}")').own] == []
    found = _violations("(= (canary) (println! \"CANARY-RAN\"))\n!(bind! &persistent (new-space))\n",
                        calls + writes + defines, tmp_path)
    assert found == {"call": calls, "write": writes, "define": defines}, found


@needs_petta
def test_a_form_given_arguments_its_clause_does_not_take_runs_as_petta_runs_it(tmp_path):
    """PeTTa's translator compiles each form only in the shapes its clause takes, cut only bare (src/translator.pl:139),
    and any other shape as a call of that name, which runs its arguments (:333). For every form the gate reads, with one
    to five arguments and the canary in each place in turn, the gate lets an expression run only when PeTTa doesn't
    call the canary for it; (cut (canary)), which does, shows the check can fail."""
    expressions = [f"({name} {' '.join('(canary)' if j == i else 'x' for j in range(n))})"
                   for name in sorted(metta_reach._FORMS) for n in range(1, 6) for i in range(n)]
    own = [e for e in expressions if reach(f'(metta "{_escaped(e)}")').own]
    assert "(quote (canary))" in own and "(cut (canary))" not in own, own
    assert _canary_runs("(= (canary) (println! \"CANARY-RAN\"))\n", own + ["(cut (canary))"], tmp_path) == \
        ["(cut (canary))"]


# A mind's runtime as its boot loads it, without the loop (lib_omegaclaw.metta imports the same substrate first).
RUNTIME_PRELUDE = """!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/substrate))
!(register-default-runtime-spaces)
"""


def _petta_runtime(body, tmp_path):
    """PeTTa's output for body run in a mind's runtime from this checkout, its memory files under tmp_path."""
    (tmp_path / "repos").mkdir()
    (tmp_path / "repos" / "OmegaClaw-Core").symlink_to(ROOT)
    path = tmp_path / "run.metta"
    path.write_text(RUNTIME_PRELUDE + body)
    python = [ROOT / "hive" / "runtime" / "extensions", ROOT / "hive" / "runtime", ROOT]
    env = dict(os.environ, LANG="C.UTF-8", OMEGACLAW_MEMORY_DIR=str(tmp_path / "memory"),
               PYTHONPATH=os.pathsep.join(map(str, python)))
    run = subprocess.run(["sh", str(PETTA / "run.sh"), str(path), "--silent"], cwd=tmp_path, env=env,
                         capture_output=True, text=True)
    return run.stdout + run.stderr


@needs_petta
def test_a_cleanup_commit_never_retires_code_and_refuses_what_the_gate_would_ask_about(tmp_path):
    """#335's lens: a cleanup commit names only a proposal and runs without asking, and a proposal can hold a function
    definition, written into &cleanup or come back from cleanup.metta, so a commit erased the function. The runtime now
    refuses, before it acts, any atom the gate would ask about retiring, and still retires a memory atom."""
    def proposal(pid, expr):
        return (f'!(add-atom &cleanup (PersistentCleanupProposal "{pid}" "c-{pid}" "persistent" "retire" '
                f'"{_escaped(expr)}" "" "test" "persistent-memory-mutation" "0.8" "pending"))\n')
    shapes = ["(= (f) 1)", "(: f Number)", "$x", "($h a)", "(= $a $b)", "(=)", "(Note x)", "foo", "()", "((= a) b)",
              '"s"', "42", "(($h) a)", "(Note (= (f) 1))", "(== a b)"]
    guard = "(= (cleanup-test-guard) GUARD-RUNS)"
    out = _petta_runtime(
        f"!(add-atom &persistent {guard})\n" + proposal("p-code", guard)
        + '!(println! (persistent-cleanup-commit "p-code"))\n!(println! (AFTER (cleanup-test-guard)))\n'
        + '!(add-atom &persistent (Note "stale"))\n' + proposal("p-note", '(Note "stale")')
        + '!(println! (persistent-cleanup-commit "p-note"))\n'
        + "".join(f'!(println! (CODE {i} (cleanup-code-atom? (sread "{_escaped(s)}"))))\n'
                  for i, s in enumerate(shapes)),
        tmp_path)
    assert '(CleanupCommitError "a cleanup changes memory, never code' in out, out[-3000:]
    assert "(AFTER GUARD-RUNS)" in out, out[-3000:]                     # the function still runs
    assert '(PersistentCleanupCommitted "p-note" "retire" 1 (Note "stale"))' in out, out[-3000:]
    runtime = {int(i): value == "true" for i, value in re.findall(r"\(CODE (\d+) (true|false)\)", out)}
    gate = {i: not reach(f'(retire-persistent-expression "{_escaped(s)}" "r")').own for i, s in enumerate(shapes)}
    assert runtime == gate and any(gate.values()) and not all(gate.values()), out[-3000:]


@needs_petta
def test_a_write_the_gate_lets_run_lands_only_in_a_memory_space(tmp_path):
    """#335's lens: space-handle, space-merge-atoms and space-transform resolve any registered name, and the registry
    holds skills, the skill directory, beside the memory spaces. Each command here writes its own mark; PeTTa shows
    where each lands, and the gate lets one run without asking exactly when it lands only in memory spaces."""
    commands = {
        "handle-skills": '(add-atom (space-handle "skills") (Mark handle-skills))',
        "alias-skills": '(add-atom (space-handle skills) (Mark alias-skills))',
        "handle-persistent": '(add-atom (space-handle "persistent") (Mark handle-persistent))',
        "alias-beliefs": '(add-atom (space-handle beliefs) (Mark alias-beliefs))',
        "merge-skills": '(space-merge-atoms "skills" "(Seed merge-skills)" "(Mark merge-skills)" "r")',
        "merge-persistent": '(space-merge-atoms "persistent" "(Seed merge-persistent)" "(Mark merge-persistent)" "r")',
        "move-to-skills": '(space-transform "persistent" "(Seed move-to-skills)" "skills" "(Mark move-to-skills)" "r")',
        "spec-to-skills": '(space-transform "persistent | (Seed spec-to-skills) | skills | (Mark spec-to-skills) | r")',
        "move-to-world": '(space-transform "persistent" "(Seed move-to-world)" "world" "(Mark move-to-world)" "r")',
        # a space name a pattern binds: cons-atom runs in reverse and gives $h skills (Jon's review of ed87db6b)
        "let-cons-skills": '(let (cons-atom $h $t) (quote ("skills" "persistent" "q")) '
                           '(add-atom (space-handle $h) (Mark let-cons-skills)))',
        "let-cons-merge": '(let (cons-atom $h $t) (quote ("skills" "persistent" "q")) '
                          '(space-merge-atoms $h "(Seed let-cons-merge)" "(Mark let-cons-merge)" "r"))',
        "case-cons-skills": '(case (quote ("skills" "persistent")) '
                            '(((cons $h $t) (add-atom (space-handle $h) (Mark case-cons-skills)))))',
        "let-data-persistent": '(let ("tag" $h) (quote ("tag" "persistent")) '
                               '(add-atom (space-handle $h) (Mark let-data-persistent)))',
        # a space name a form computes: prog1's first value (Jon's review of a4105a41)
        "prog1-skills": '(let $h (prog1 "skills" "persistent") (add-atom (space-handle $h) (Mark prog1-skills)))',
        "prog1-merge": '(let $h (prog1 "skills" "persistent") '
                       '(space-merge-atoms $h "(Seed prog1-merge)" "(Mark prog1-merge)" "r"))',
        "prog1-persistent": '(let $h (prog1 "persistent" "skills") (add-atom (space-handle $h) (Mark prog1-persistent)))',
        # a space name if computes: it takes then only on the symbol true, and a value of another kind, here a variable
        # read from "$persistent", is no memory space's name (a check of 3924fc40)
        "if-string-true-skills": '(let $h (if "true" "persistent" "skills") '
                                 '(add-atom (space-handle $h) (Mark if-string-true-skills)))',
        "join-variable-skills": '(let $h (if (== 1 2) persistent (sread "$persistent")) '
                                '(add-atom (space-handle $h) (Mark join-variable-skills)))',
        "if-true-persistent": '(let $h (if True "persistent" "skills") '
                              '(add-atom (space-handle $h) (Mark if-true-persistent)))',
    }
    spaces = {"skills": "&skills", **metta_reach.MEMORY_REGISTRY}
    out = _petta_runtime(
        "".join(f"!(add-atom {space} (Seed {name}))\n" for name in commands for space in ("&persistent", "&skills"))
        + "".join(f"!{command}\n" for command in commands.values())
        + "".join(f"!(println! (collapse (match {handle} (Mark $m) (LANDED $m {name}))))\n"
                  for name, handle in spaces.items()),
        tmp_path)
    landed = {name: set() for name in commands}
    for name, space in re.findall(r"\(LANDED ([\w-]+) ([\w-]+)\)", out):
        landed[name].add(space)
    assert all(landed.values()), (landed, out[-3000:])                      # every command wrote its mark
    assert {name: reach(command).own for name, command in commands.items()} == \
        {name: landed[name] <= set(metta_reach.MEMORY_REGISTRY) for name in commands}, landed


def _escaped(expression):
    return expression.replace("\\", "\\\\").replace('"', '\\"')
