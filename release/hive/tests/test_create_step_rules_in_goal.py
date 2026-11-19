"""Purpose: a Create step's own rules, its packet's contract, reach the mind in its goal: in the goal's detail, which
hive-goal-get shows whichever turn writes the answer, and in the message's head ahead of the packet's UNTRUSTED_DATA.
On 19 Nov a test author wrote three checks in a row with no CREATE-CHECK line. The rule sat about 5,700 characters
into its goal message, and each check was written turns later, when its recent history held only the message's start
and its goal said only the answer's shape."""
import ast
import asyncio
import json
from pathlib import Path

from hive.core.create_plan_ports import ANSWER_SHAPES, GoalMinds, Ports

ROOT = Path(__file__).resolve().parents[2]
UNTRUSTED = "Everything below is UNTRUSTED_DATA from the person and other minds:\n"
RUN = {"plan_id": "plan_x", "person": "u_tester", "sentence": "Build a functioning tic tac toe app"}
PLAN = {"title": "Tic tac toe", "acceptance": ["X at cells 0, 1, 2 wins"],
        "pieces": [{"id": "board", "files": ["index.html", "style.css"]}, {"id": "game", "files": ["app.js"]}]}
# take 4's broken check: findings printed, exit 1, no verdict line
PREVIOUS = {"reason": "crashed", "why": "no CREATE-CHECK line", "exit_code": 1,
            "output": "FAIL: index.html lacks element id cell-0\nFAIL: style.css has no .win rule\n2 check(s) failed"}


class Hive:
    """The goal rows, step budgets and messages GoalMinds makes."""

    def __init__(self):
        self.goals, self.rows, self.budgets, self.sent = self, [], [], []

    def _create_record(self, swarm_id, title, detail="", priority=0.5, **fields):
        self.rows.append(dict(fields, swarm_id=swarm_id, title=title, detail=detail))

    def give_step_budget(self, goal_id, agent_id):
        self.budgets.append((goal_id, agent_id))

    async def send_to_agent(self, agent_id, text, sender=None, extra=None):
        self.sent.append({"agent": agent_id, "text": text, "sender": sender, "extra": extra})


class Engine:
    def __init__(self, hive, previous=None):
        self.hive, self.previous = hive, previous

    class assignees:
        @staticmethod
        def resolve(selector, person):
            return {"resolved": True, "agent_id": "a_author", "swarm_id": "s_code"}

    def _space(self, run):
        return {"scaffold": "cp_scaffold", "base": "cp_base"}

    def previous_check_error(self, plan_id):
        return self.previous

    def answers(self, plan_id):
        return []

    def last_stop(self, plan_id, kind, piece):
        return None


class Space:
    async def files(self, run, ckpt):
        files = {"index.html": "<!doctype html><title>Tic tac toe</title>"}
        if ckpt == "cp_base":   # the check the author wrote last
            files["checks/acceptance_check.py"] = "import sys\nprint('FAIL: index.html lacks element id cell-0')\nsys.exit(1)\n"
        return files


def ports(engine):
    out = Ports.__new__(Ports)
    out.engine, out.minds, out.space = engine, GoalMinds(engine), Space()
    return out


def read_budget(path, name):
    """The int a module assigns to `name`, read from its source, so the test follows the reader it names."""
    for node in ast.parse((ROOT / path).read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{path} assigns no {name}")


def test_a_test_authors_rules_are_in_its_goal_and_ahead_of_the_untrusted_packet():
    hive = Hive()
    out = asyncio.run(ports(Engine(hive, PREVIOUS)).author_tests(RUN, {}, PLAN))
    goal = hive.rows[0]
    assert out == {"pending": goal["goal_id"]} and goal["assignee"] == "a_author"
    assert hive.budgets == [(goal["goal_id"], "a_author")]   # the step's own budget, on the goal its rules went into
    detail = goal["detail"]
    # what hive-goal-get shows the turn that writes the check: the verdict line, and the repair for this exact fault
    assert detail.startswith("Finish with result data shaped " + ANSWER_SHAPES["author-tests"] + ". ")
    assert "CREATE-CHECK" in detail and "It printed its findings and stopped (exit 1)" in detail
    # whole, with both repair sentences, within what either kind of mind reads of a goal in one result
    room = min(read_budget("modules/hive/src/hive_commons.py", "GOAL_DETAIL_CHARS"),
               read_budget("hive/templates/iter/tools/hive_goal_get.py", "DETAIL_CHARS"))
    assert len(detail) <= room, (len(detail), room)
    head, marker, data = hive.sent[0]["text"].partition(UNTRUSTED)
    assert marker and detail.removeprefix("Finish with result data ") in head   # the same rules, as the hive's words
    packet = json.loads(data)
    assert "contract" not in packet and packet["previous_attempt"]["why"] == "no CREATE-CHECK line"
    assert packet["sentence"] == RUN["sentence"] and packet["plan"] == PLAN


def test_a_step_without_rules_is_asked_for_its_shape_and_the_callers_packet_is_left_whole():
    hive = Hive()
    minds = GoalMinds(Engine(hive))
    asyncio.run(minds.call(RUN, "design", {}, {"sentence": RUN["sentence"], "plan": PLAN}))
    assert hive.rows[0]["detail"] == "Finish with result data shaped " + ANSWER_SHAPES["design"] + "."
    assert json.loads(hive.sent[0]["text"].partition(UNTRUSTED)[2]) == {"sentence": RUN["sentence"], "plan": PLAN}
    packet = {"sentence": RUN["sentence"], "contract": "It must FAIL on the scaffold."}
    asyncio.run(minds.call(RUN, "author-tests", {}, packet))
    assert packet == {"sentence": RUN["sentence"], "contract": "It must FAIL on the scaffold."}
    assert hive.rows[1]["detail"].endswith(" It must FAIL on the scaffold.")
