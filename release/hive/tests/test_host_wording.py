"""Host wording (host-wording r1): the hive's own server text calls a swarm a swarm and work motivations and tasks.

Jon's standing rulings: no Goals/Boards (work is Motivations and Tasks), and a group of minds is a swarm, never a team.
The UI said so in uifix-r1; this guard holds the host's shown text to the same words, as test_bench_names does for "dot".

- "team", "teams", "teammate(s)", "subgoal(s)": no string the host can show (every string constant in hive/**/*.py
  outside tests, vendor code and docstrings, so error messages, prompts, room names, notices and log lines) uses them.
- "goal(s)" is also the name of the record, its routes, table, keys and tools (hive_goal_*, /api/agent/goals,
  ``goal_id``), which stay. So it is checked where text is clearly shown: every error message (the message argument of
  an error call), every ``description`` a mind reads, and whole files that are shown text (the Lab bench, the built-in
  roles, a mind's workspace prompt, the Iter kit's tool descriptions and memory note, Health's notices, swarm rooms).
- A word glued to an identifier character (``team_``, ``team-room``, ``/goals``, ``from_goal``, ``hive-goal-get``,
  ``goals.py``) is an identifier and passes, as in the UI's ownerWords.
- Every other use is allowed by its exact file, text and number of uses, with the reason; an allowance nothing needs,
  or one that now covers more uses than it names, fails the build.
- Old names may appear only in hive/bench/names.py (legacy aliases, so stored runs still pair).
"""

import ast
import pathlib
import re
from collections import Counter

HIVE = pathlib.Path(__file__).resolve().parents[1]

EDGE_BEFORE = r"(?<![-_/.$\w])"
EDGE_AFTER = r"(?![-_/(\w]|\.\w)"
ALWAYS = re.compile(EDGE_BEFORE + r"(team(?:mates?|s)?|subgoals?)" + EDGE_AFTER, re.IGNORECASE)
GOAL = re.compile(EDGE_BEFORE + r"(goals?)" + EDGE_AFTER, re.IGNORECASE)

# Whole files of shown text, where "goal" is checked in every string.
GOAL_FILES = ["bench/benchmarks.py", "bench/catalog.py", "core/roles.py", "core/rooms.py", "core/health.py",
              "supervisor/workspace.py"] + sorted(f"templates/iter/tools/{p.name}"
                                                  for p in (HIVE / "templates/iter/tools").glob("*.py"))
TEXT_FILES = ["templates/iter/memory/hive.txt", "templates/omega/prompt.txt"]   # shown whole: every line is checked
ERROR_CALLS = {"error", "err", "_err", "_bad", "fail", "HiveError", "ServiceError", "RoleError", "DispatchUnavailable"}
SKIP = ("tests/", "core/vendor/")
LEGACY_SOURCE = "bench/names.py"                       # the old names, kept as aliases

KEY = "a key, value or column name, never shown as wording"
TASK_GOAL = "the tool is named hive_goal*: the description says task and names the tool's word once, in brackets"
ALLOWED = {
    # ---- team
    ("core/limits_view.py", "teams"): f"{KEY}: the 'teams' list in GET /api/budgets/limits (API.md)",
    ("core/limits_view.py", "team"): f"{KEY}: an auto-candidate row's kind",
    ("core/mcp.py", "team"): f"{KEY}: hive_motivation_create's scope value",
    ("core/mcp.py", "Name an aim (a motivation) of your own (scope self, the default) or of your swarm (scope team). The hive "
                    "records you as its creator and scopes it to your swarm, whose people can see it. operation_id is "
                    "required: a retry with the same id and body returns the first motivation and creates nothing new."):
        "names the scope value 'team' a mind passes; the words say swarm",
    ("core/minds.py", "teams"): f"{KEY}: a mind template's registration list (minds.py templates); used 4 times",
    ("core/minds.py", ": teams lists the swarms it is registered for"): "names the template file's 'teams' key",
    ("core/motivations.py", "team"): f"{KEY}: a motivation's scope value",
    ("core/motivations.py", "scope is self (yours) or team (your swarm's)"): "names the two scope values a caller passes",
    ("core/rooms.py", "Your swarm's team room: minds reach each other here with @Name."):
        "LEGACY_TEAM_TOPIC: the old stored default topic, matched so it is shown in the new words",
    ("core/rooms.py", " team"): "LEGACY_TEAM_SUFFIX: the old stored name ending, matched so it is shown as ' room'",
    ("core/rooms.py", "SELECT id, swarm_id, alias FROM rooms WHERE alias LIKE 'team\\_%' ESCAPE '\\' AND archived = 0 AND "
                      "NOT EXISTS (SELECT 1 FROM swarms s WHERE s.id = rooms.swarm_id)"): f"{KEY}: the room alias prefix team_",
    ("core/rooms.py", "team"): f"{KEY}: a mind's room list marks the swarm's room with 'team': true",
    # ---- goal (checked only where text is shown)
    ("bench/benchmarks.py", "goals"): f"{KEY}: the goals table (the bench lapses a lease directly)",
    ("core/health.py", "goal"): f"{KEY}: an owed item's type (made and read: 2 uses)",
    ("core/health.py", "SELECT id, title, status, updated_at FROM goals WHERE claimed_by = ? AND status IN ('claimed', "
                       "'waiting') AND updated_at < ? ORDER BY updated_at"): f"{KEY}: SQL",
    ("core/health.py", "SELECT id, title, updated_at FROM goals WHERE assignee = ? AND status = 'open' AND updated_at < ? "
                       "ORDER BY updated_at"): f"{KEY}: SQL",
    ("core/mcp.py", "Your swarm's tasks (goals). status: open (default), claimed, done, or all."): TASK_GOAL,
    ("core/mcp.py", "Claim an open task (goal) so others know you are on it. A claim is a lease: report a result before "
                    "it lapses."): TASK_GOAL,
    ("core/mcp.py", "One task (goal) in full: detail, binding and binding_digest, deadline, result schema and review spec."):
        TASK_GOAL,
    ("core/mcp.py", "Report on a task (goal) you hold: done with a result, failed with why, or waiting on a person. A bound "
                    "task needs its binding_digest (top level, exactly as hive_goal_get shows it). data is the structured "
                    "result; it is checked against the task's result schema."): TASK_GOAL,
    ("core/mcp.py", "Renew the lease on a task (goal) you hold (also resumes it from waiting). Never reopens cancelled, "
                    "expired or done work."): TASK_GOAL,
    ("core/mcp.py", "Acknowledge that a task (goal) you held was cancelled or expired, and stop work on it."): TASK_GOAL,
    ("core/mcp.py", "Propose a new task (goal), or a subtask of one you hold, for your swarm."): TASK_GOAL,
}


def _docstrings(tree):
    return {id(n.body[0].value) for n in ast.walk(tree)
            if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and n.body
            and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}


def _strings(node, skip=frozenset()):
    return [c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str) and id(c) not in skip]


def _call_name(call):
    f = call.func
    return f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")


def host_sources():
    """{path relative to hive/: source} for every host Python file a guard reads."""
    return {str(p.relative_to(HIVE)): p.read_text(encoding="utf-8") for p in sorted(HIVE.rglob("*.py"))
            if not str(p.relative_to(HIVE)).startswith(SKIP)}


def shown_strings(name, source):
    """(every non-docstring string, the strings where "goal" is checked) for one host file."""
    tree = ast.parse(source)
    every = _strings(tree, _docstrings(tree))
    if name in GOAL_FILES:
        return every, every
    goal = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and _call_name(n) in ERROR_CALLS:
            goal += [s for a in n.args for s in _strings(a)]
        if isinstance(n, ast.Dict):
            goal += [s for k, v in zip(n.keys, n.values)
                     if isinstance(k, ast.Constant) and k.value == "description" for s in _strings(v)]
    return every, goal


# An allowance covers one use unless it says how many (the same key string written more than once).
ALLOWED_USES = {("core/minds.py", "teams"): 4, ("core/health.py", "goal"): 2}


def offences(sources, texts=None):
    """Counter{(file, text): uses} for every shown string using a retired word, before allowances."""
    out = Counter()
    for name, source in sources.items():
        if name == LEGACY_SOURCE:
            continue
        every, goal = shown_strings(name, source)
        out.update((name, s) for s in every if ALWAYS.search(s))
        out.update((name, s) for s in goal if GOAL.search(s) and not ALWAYS.search(s))   # a string counts once
    for name, text in (texts if texts is not None else {n: (HIVE / n).read_text(encoding="utf-8") for n in TEXT_FILES}).items():
        out.update((name, line) for line in text.splitlines() if ALWAYS.search(line) or GOAL.search(line))
    return out


def unallowed(found):
    """The uses no allowance covers: an unknown text, or more uses of an allowed text than it names."""
    return sorted(k for k, n in found.items() if n > (ALLOWED_USES.get(k, 1) if k in ALLOWED else 0))


def test_no_shown_host_string_says_team_or_goal():
    assert unallowed(offences(host_sources())) == []


def test_every_allowance_is_still_needed():
    found = offences(host_sources())
    assert sorted(k for k in ALLOWED if found[k] != ALLOWED_USES.get(k, 1)) == []


def test_the_guard_catches_reintroduced_wording():
    sources = host_sources()
    # a room name, an error message, a bench measure, a role prompt, an Iter tool description
    for name, now, then in [
        ("core/rooms.py", 'return f"{swarm_name} room"[:80]', 'return f"{swarm_name} team"[:80]'),
        ("core/motivations.py", "a motivation is owned by a person (user:u_...) or a swarm (swarm:s_...)",
         "a motivation is owned by a person (user:u_...) or a team (swarm:s_...)"),
        ("core/goals.py", '"say what was done: a task is not done without a result"', '"say what was done: a goal is not done without a result"'),
        ("bench/benchmarks.py", 'metric("subtasks accepted"', 'metric("subgoals accepted"'),
        ("core/roles.py", "Take one subtask at a time", "Take one subgoal at a time"),
        ("templates/iter/tools/hive_goal_claim.py", "Claim a swarm task by id", "Claim a swarm goal by id"),
        ("supervisor/workspace.py", "post in your swarm's room", "post in your swarm's team room"),
        ("core/minds.py", '"that swarm does not offer \'code\'"', '"that team does not offer \'code\'"'),
    ]:
        changed = dict(sources)
        assert changed[name].count(now) == 1, (name, now)
        changed[name] = changed[name].replace(now, then)
        assert any(f == name for f, _ in unallowed(offences(changed))), (name, then)
    note = {"templates/iter/memory/hive.txt": "Goals: hive_goals shows yours"}
    assert unallowed(offences({}, note)) == [("templates/iter/memory/hive.txt", "Goals: hive_goals shows yours")]


def test_an_allowance_covers_only_its_own_text():
    changed = dict(host_sources())
    changed["core/motivations.py"] = changed["core/motivations.py"].replace(
        '"scope is self (yours) or team (your swarm\'s)"', '"scope is self (yours) or team (your team\'s)"')
    assert ("core/motivations.py", "scope is self (yours) or team (your team's)") in unallowed(offences(changed))


def test_identifiers_pass():
    probe = {"core/x.py": 'raise self.hive.error(400, "bad", "from_goal, hive-goal-get, /api/agent/goals, '
                          'goal_id, team_room_unavailable, /api/swarms/s/team-room/repair, goals.py")\n'}
    assert offences(probe, {}) == Counter()
    probe = {"core/x.py": 'raise self.hive.error(400, "bad", "no such goal")\nX = "the team"\n'}
    assert unallowed(offences(probe, {})) == [("core/x.py", "no such goal"), ("core/x.py", "the team")]
