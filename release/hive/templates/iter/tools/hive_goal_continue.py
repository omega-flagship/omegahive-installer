# Purpose: create a linked follow-up to a completed task while preserving its completion and review requirements.
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

# The follow-up's read comes back in this tool's own result, through the same transport.
_get_spec = importlib.util.spec_from_file_location("_hive_goal_get", Path(__file__).resolve().parent / "hive_goal_get.py")
_get = importlib.util.module_from_spec(_get_spec)
_get_spec.loader.exec_module(_get)
_get._hive = _hive

DESCRIPTION = ("Continue completed work with a new instruction. Creates a linked new task that is already yours, carrying "
               "the earlier instructions and result, and returns it in full. Finish it like any task: hive_goal_done, "
               "or hive_goal_propose when it shows a RESULT SCHEMA. The old task stays complete.")


def run(goal_id, instruction):
    goal, error = _hive.call("POST", f"/api/agent/goals/{goal_id}/continue", {"instruction": instruction})
    if error:
        return error
    head = (f"continued as {goal['id']}, which is yours: finish it with hive_goal_done({goal['id']}, done, <the finished "
            "work>), or hive_goal_propose if it shows a RESULT SCHEMA\n")
    return head + _get.read(goal["id"], len(head))
