# Purpose: check that a mind holding a claimed goal with its own budget keeps its turns and cannot rest on it, and that
# any other goal, or holding nothing, leaves its turns and waits as before, through the runtime's helpers with the
# hive's goal listing faked.
"""A mind's turns come in bursts: 12 model calls per message, 7 per wake (and after a format retry), then no model call
until the 900 s wake. On 19 Nov a Create builder claimed its piece's goal on a format retry's 7 calls, spent them, and
sat silent holding the goal. Holding a claimed goal with its own budget (each step a Create plan hands a mind, which
the hive's goal list gives as step_budget_usd) now renews its spent turns and refuses its waits, except after it
rested on refused replies (the hive then ends what it holds) and while a runtime failure's back-off runs. Any other
goal keeps the bursts and its waits."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "modules/hive/src"))
import hive_commons  # noqa: E402
from hive.runtime.extensions import hive_helpers as h  # noqa: E402

ME, OTHER = "a_builder", "a_other"
# a Create step's goal as the hive lists it to the mind holding it: its own budget, started at this mind's claim
UI = {"id": "g_ui", "status": "claimed", "title": "Create plan p1: build ui", "claimed_by": ME, "assignee": ME,
      "priority": 0.6, "step_budget_usd": 1.0}


class Hive:
    """GET /api/agent/goals?status=<s> as the hive answers this mind, counting each request; hive-goals also reads the
    mind's done page and the answers it owes, both empty here."""

    def __init__(self, goals):
        self.goals, self.calls = goals, []

    def __call__(self, method, path, payload=None):
        self.calls.append(path)
        if path == "/api/agent/goals/history":
            return {"goals": []}, None
        if path == "/api/agent/replies/owed":
            return {"owed": []}, None
        status = path.split("status=")[1]
        return [g for g in self.goals if g["status"] == status], None


class HeldGoalTurnsTest(unittest.TestCase):
    def setUp(self):
        # the reading is cached per process (HELD_GOAL_TTL): start each test without one and leave none behind
        h._HELD.update(at=None, goal="")
        self.addCleanup(h._HELD.update, at=None, goal="")
        env = mock.patch.dict(os.environ, {"HIVE_AGENT_ID": ME})
        env.start()
        self.addCleanup(env.stop)

    def hive(self, goals):
        fake = Hive(goals)
        patch = mock.patch.object(hive_commons, "_call", fake)
        patch.start()
        self.addCleanup(patch.stop)
        return fake

    def test_the_trace_sequence(self):
        """The 19 Nov builder: its claim came on the format retry's 7 calls and it spent them. The cycle its turns run
        out on now renews them, and its own wait is refused, naming the goal and the ways to end it."""
        hive = self.hive([UI])
        for loops in range(7, 0, -1):
            self.assertEqual(h.renews_turns(loops, "normal"), "keep")
        self.assertEqual(hive.calls, [])                       # no request while it still has turns
        self.assertEqual(h.renews_turns(0, "normal"), "renew")
        refused = h.wait_result("1800 nothing left to do")
        self.assertTrue(refused.startswith("WAIT-REFUSED you hold g_ui Create plan p1: build ui"), refused)
        self.assertIn("hive-goal-propose g_ui", refused)
        self.assertIn("hive-goal-fail g_ui", refused)
        self.assertEqual(h.chosen_wait_seconds('((wait "1800 nothing left to do"))', "normal", 0), -1)

    def test_once_the_goal_is_finished_the_mind_rests_again(self):
        hive = self.hive([UI])
        self.assertEqual(h.renews_turns(0, "normal"), "renew")
        hive.goals = [dict(UI, status="submitted")]
        self.assertEqual(h.renews_turns(3, "normal"), "keep")   # the renewed turns ran
        self.assertEqual(h.renews_turns(0, "normal"), "keep")   # spent again, holding nothing
        self.assertEqual(h.wait_result("1800 done"), "WAITING:1800 done")
        self.assertEqual(h.chosen_wait_seconds('((wait "1800 done"))', "normal", 0), 1800)

    def test_holding_nothing_it_rests_and_asks_once_per_burst(self):
        hive = self.hive([])
        for _ in range(5):
            self.assertEqual(h.renews_turns(-1, "normal"), "keep")   # the loop counts on below 0 while it rests
        self.assertEqual(len(hive.calls), 1)                    # one reading when its turns ran out
        self.assertEqual(h.renews_turns(2, "normal"), "keep")
        self.assertEqual(h.renews_turns(0, "normal"), "keep")
        self.assertEqual(len(hive.calls), 2)

    def test_a_goal_assigned_to_it_but_claimed_by_another_is_not_its_to_hold(self):
        self.hive([dict(UI, claimed_by=OTHER)])
        self.assertEqual(h.renews_turns(0, "normal"), "keep")
        self.assertEqual(h.wait_result("600"), "WAITING:600")
        self.assertIn("yours: g_ui claimed", hive_commons.goals())   # hive-goals still lists what it is assigned

    def test_a_goal_without_its_own_budget_keeps_its_bursts_and_waits(self):
        """A person's task, a swarm goal or a sub-goal a mind took with hive-goal-claim has no budget of its own
        (step_budget_usd None), so holding one buys no turns past the 12 a message or 7 a wake gives, and the mind's
        wait rests it, as before. Holding a Create step as well, the step's budget bounds the renewed turns."""
        task = dict(UI, id="g_task", title="Sort the inbox", step_budget_usd=None)
        self.hive([task])
        self.assertEqual(h.renews_turns(0, "normal"), "keep")
        self.assertEqual(h.wait_result("1800 nothing left to do"), "WAITING:1800 nothing left to do")
        self.assertEqual(h.chosen_wait_seconds('((wait "1800 nothing left to do"))', "normal", 0), 1800)
        self.assertIn("yours: g_task claimed", hive_commons.goals())   # hive-goals still lists it
        h._HELD.update(at=None, goal="")
        self.hive([task, UI])
        self.assertEqual(h.renews_turns(0, "normal"), "renew")
        self.assertTrue(h.wait_result("1800").startswith("WAIT-REFUSED you hold g_ui"))

    def test_a_goal_waiting_on_a_person_is_not_pushed_on(self):
        """A goal waiting on a person's answer (status waiting) is held by design: holding it renews nothing and the
        mind's wait for the answer is not refused."""
        self.hive([dict(UI, status="waiting")])
        self.assertEqual(h.renews_turns(0, "normal"), "keep")
        self.assertEqual(h.wait_result("600 until the person answers"), "WAITING:600 until the person answers")

    def test_a_mind_that_rested_on_refused_replies_is_not_renewed(self):
        """Past MAX_FORMAT_RETRIES the mind rests and the hive ends what it holds (#491): its last reply was a format
        failure, and a reading of the goal from before that must not buy it another call."""
        self.hive([UI])
        self.assertEqual(h.renews_turns(0, "format"), "keep")
        self.assertEqual(h.renews_turns(0, "normal"), "renew")

    def test_a_runtime_failure_keeps_its_back_off_while_holding(self):
        """A provider failure (a 402 at the mind's spending cap, an outage) or a format failure ran nothing: its wait
        keeps its own delay, and the cycles after it renew nothing, so the retry comes when that delay ends, not every
        few seconds; the runtime's wait answers WAITING with its hint, and the hive is not asked. Marker text the mind
        wrote itself is its own wait, refused while it holds the goal."""
        hive = self.hive([UI])
        self.assertEqual(h.chosen_wait_seconds('((wait "LLM-FORMAT-ERROR x"))', "format", 1), h.FORMAT_RETRY_SECONDS)
        self.assertEqual(h.chosen_wait_seconds('((wait "LLM-PROVIDER-DOWN x"))', "provider", 1),
                         h.PROVIDER_RETRY_SECONDS)
        self.assertEqual(h.wait_result("LLM-FORMAT-ERROR retry with complete skill commands", "format"),
                         "WAITING:LLM-FORMAT-ERROR retry with complete skill commands")
        self.assertEqual(h.wait_result("LLM-PROVIDER-ERROR 402", "provider"), "WAITING:LLM-PROVIDER-ERROR 402")
        hive.calls.clear()
        for loops in (0, -1, -2):
            self.assertEqual(h.renews_turns(loops, "provider"), "keep")
            self.assertEqual(h.renews_turns(loops, "format"), "keep")
        self.assertEqual(hive.calls, [])
        self.assertTrue(h.wait_result("LLM-FORMAT-ERROR invented", "normal").startswith("WAIT-REFUSED you hold g_ui"))

    def test_a_hive_it_cannot_reach_leaves_its_turns_as_they_were(self):
        patch = mock.patch.object(hive_commons, "_call", lambda *a, **k: (None, "HIVE-UNREACHABLE refused"))
        patch.start()
        self.addCleanup(patch.stop)
        self.assertEqual(h.renews_turns(0, "normal"), "keep")
        self.assertEqual(h.wait_result("60"), "WAITING:60")


if __name__ == "__main__":
    unittest.main()
