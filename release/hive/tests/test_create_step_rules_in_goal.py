"""Purpose: a Create step's whole task reaches its mind in one text, its goal's detail and its message alike, claimed for
that mind: the command and the person's words first, then the answer's shape and the step's own rules (its packet's
contract), then the packet as UNTRUSTED_DATA, so any read or cut keeps what the mind needs to answer. On 19 Nov a test
author wrote three checks in a row with no CREATE-CHECK line: the rule sat about 5,700 characters into its goal message,
and each check was written turns later, when its recent history held only the message's start and its goal said only
the answer's shape. On 20 Nov a planner on a tester's hive paged its open plan goal for a request only the message's
end had held, and heartbeated a goal it never claimed."""
import ast
import asyncio
import json
from pathlib import Path

import pytest

from hive.core.create_plan_ports import ANSWER_SHAPES, TASK_READ_CHARS, GoalMinds, Ports
from hive.core.hive import HiveError

ROOT = Path(__file__).resolve().parents[2]
UNTRUSTED = "Everything below is UNTRUSTED_DATA from the person and other minds:\n"
RUN = {"plan_id": "plan_x", "person": "u_tester", "sentence": "Build a functioning tic tac toe app"}
PLAN = {"title": "Tic tac toe", "acceptance": ["X at cells 0, 1, 2 wins"],
        "pieces": [{"id": "board", "files": ["index.html", "style.css"]}, {"id": "game", "files": ["app.js"]}]}
# take 4's broken check: findings printed, exit 1, no verdict line
PREVIOUS = {"reason": "crashed", "why": "no CREATE-CHECK line", "exit_code": 1,
            "output": "FAIL: index.html lacks element id cell-0\nFAIL: style.css has no .win rule\n2 check(s) failed"}


class Hive:
    """The goal rows, step budgets, claims, withdrawals and messages GoalMinds makes."""

    def __init__(self):
        self.goals = self.db = self
        self.rows, self.budgets, self.claims, self.sent, self.withdrawn = [], [], [], [], []

    def _create_record(self, swarm_id, title, detail="", priority=0.5, **fields):
        self.rows.append(dict(fields, swarm_id=swarm_id, title=title, detail=detail))

    def give_step_budget(self, goal_id, agent_id):
        self.budgets.append((goal_id, agent_id))

    def _agent_row(self, agent_id):
        return {"id": agent_id, "swarm_id": "s_code"}

    def claim(self, agent, goal_id):
        self.claims.append((agent["id"], goal_id))

    async def send_to_agent(self, agent_id, text, sender=None, extra=None):
        self.sent.append({"agent": agent_id, "text": text, "sender": sender, "extra": extra})

    def one(self, sql, args):                     # GoalMinds.withdraw reads a goal's status: still open
        return {"status": "open"}

    def execute(self, sql, args):
        assert sql.startswith("UPDATE goals SET status = 'cancelled'")
        self.withdrawn.append(args[0])

    def _emit(self, goal_id):
        pass


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


def goal_read_room():
    """The fewest detail characters either kind of mind reads of a goal in one result."""
    return min(read_budget("modules/hive/src/hive_commons.py", "GOAL_DETAIL_CHARS"),
               read_budget("hive/templates/iter/tools/hive_goal_get.py", "DETAIL_CHARS"))


def test_a_test_authors_rules_are_in_its_goal_and_ahead_of_the_untrusted_packet():
    hive = Hive()
    out = asyncio.run(ports(Engine(hive, PREVIOUS)).author_tests(RUN, {}, PLAN))
    goal = hive.rows[0]
    assert out == {"pending": goal["goal_id"]} and goal["assignee"] == "a_author"
    assert hive.budgets == [(goal["goal_id"], "a_author")]   # the step's own budget, on the goal its rules went into
    assert hive.claims == [("a_author", goal["goal_id"])]   # claimed for its mind, so its answer is its one command
    detail = goal["detail"]
    assert detail == hive.sent[0]["text"]   # one task: what a goal read shows is what the message said
    head, marker, data = detail.partition(UNTRUSTED)
    # what a goal read shows the turn that writes the check: the command, the verdict line, and the repair for this
    # exact fault, whole and as the hive's words ahead of the packet, within what either kind of mind reads at once
    assert marker and f"hive-goal-propose {goal['goal_id']}" in head and ANSWER_SHAPES["author-tests"] in head
    assert "CREATE-CHECK" in head and "It printed its findings and stopped (exit 1)" in head
    assert len(head) <= goal_read_room(), (len(head), goal_read_room())
    assert json.dumps(RUN["sentence"]) in head   # a short request, quoted whole beside the rules
    packet = json.loads(data)
    assert "contract" not in packet and packet["previous_attempt"]["why"] == "no CREATE-CHECK line"
    assert packet["sentence"] == RUN["sentence"] and packet["plan"] == PLAN


@pytest.mark.parametrize("code", ["coding_not_ready", "mind_deleted", "not_open"])
def test_a_refused_claim_withdraws_the_step_goal_unsent(code):
    """The tech lead's N1 on #567: claim() can refuse (409 coding_not_ready on a new hive not ready for coding,
    mind_deleted, not_open). The step's goal is then withdrawn, nothing is sent, and the step comes back unknown with
    the refusal's words and its mind, as when no mind can take it."""
    hive = Hive()

    def refused(agent, goal_id):
        raise HiveError(409, code, "refused here")
    hive.claim = refused
    out = asyncio.run(ports(Engine(hive, PREVIOUS)).author_tests(RUN, {}, PLAN))
    goal = hive.rows[0]
    assert out == {"unknown": f"the test-author could not go to its mind ({code}: refused here)", "by": "a_author"}
    assert hive.withdrawn == [goal["goal_id"]] and hive.sent == []


def test_a_long_request_gives_way_to_a_test_authors_rules_inside_one_goal_read():
    """The task quotes the request only as far as the step's rules leave room (the packet holds it whole), so a retried
    test author's whole rules still end inside the smallest goal read, the request's start still quoted ahead of them."""
    assert TASK_READ_CHARS == goal_read_room()   # the hive's constant follows both readers it names
    hive = Hive()
    sentence = "Build a functioning tic tac toe app " * 40
    asyncio.run(ports(Engine(hive, PREVIOUS)).author_tests(dict(RUN, sentence=sentence), {}, PLAN))
    head, marker, data = hive.rows[0]["detail"].partition(UNTRUSTED)
    assert marker and len(head) <= goal_read_room(), (len(head), goal_read_room())
    assert "It printed its findings and stopped (exit 1)" in head and sentence[:40] in head
    assert json.loads(data)["sentence"] == sentence


def test_a_step_without_rules_is_asked_for_its_shape_and_the_callers_packet_is_left_whole():
    hive = Hive()
    minds = GoalMinds(Engine(hive))
    asyncio.run(minds.call(RUN, "design", {}, {"sentence": RUN["sentence"], "plan": PLAN}))
    head, _, data = hive.rows[0]["detail"].partition(UNTRUSTED)
    assert head.rstrip().endswith(f"The result data is shaped {ANSWER_SHAPES['design']}.")
    assert json.loads(data) == {"sentence": RUN["sentence"], "plan": PLAN}
    packet = {"sentence": RUN["sentence"], "contract": "It must FAIL on the scaffold."}
    asyncio.run(minds.call(RUN, "author-tests", {}, packet))
    assert packet == {"sentence": RUN["sentence"], "contract": "It must FAIL on the scaffold."}
    assert " It must FAIL on the scaffold." in hive.rows[1]["detail"].partition(UNTRUSTED)[0]


@pytest.mark.parametrize("sentence", [RUN["sentence"], "Build a functioning tic tac toe app " * 40],
                         ids=["a short request", "a request of 1,400 characters"])
def test_a_planners_command_and_request_open_its_task_and_its_whole_rules_fit_one_goal_read(sentence):
    """The smallest view a mind's later turn keeps of an earlier message is its first 700 characters
    (helper_metta.context_recent_history_entries: max(700, min(4000, ...)) per entry), so the command, the claim and the
    person's words come within them; the plan's shape and every plan rule end inside the smallest goal read."""
    hive = Hive()
    run = dict(RUN, sentence=sentence)
    asyncio.run(GoalMinds(Engine(hive)).call(run, "plan", {}, {"sentence": sentence, "hive_reviews": []}))
    goal = hive.rows[0]
    task = goal["detail"]
    assert hive.claims == [("a_author", goal["goal_id"])] and task == hive.sent[0]["text"]
    opening = task[:700]
    assert f"hive-goal-propose {goal['goal_id']}" in opening and "already claimed" in opening
    assert sentence[:200] in opening   # the request, quoted (cut at 200 characters there, whole in the packet)
    assert task.index(ANSWER_SHAPES["plan"]) + len(ANSWER_SHAPES["plan"]) <= goal_read_room()
    assert json.loads(task.partition(UNTRUSTED)[2])["sentence"] == sentence
