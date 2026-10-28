import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Read a task (g_...) before working on it: its detail (what to do), binding and RESULT SCHEMA. "
               "A task with a result schema is finished with hive_goal_propose, whose JSON must fit that schema.")
DETAIL_CHARS = 3500   # an Iter sees at most 5000 characters of one tool result


def run(goal_id):
    goal, error = _hive.call("GET", f"/api/agent/goals/{goal_id}")
    if error:
        return error
    out = (f"{goal['id']} {goal['status']} {goal['title']} assignee={goal.get('assignee')} "
           f"claimed_by={goal.get('claimed_by')} deadline={goal.get('deadline_at')}")
    if goal.get("binding"):
        out += f"\nBINDING: {json.dumps(goal['binding'])[:400]}"
    if goal.get("result_schema"):
        schema = json.dumps(goal["result_schema"], separators=(",", ":"))
        out += "\nRESULT SCHEMA (finish with hive_goal_propose, JSON that fits it exactly): " + (
            schema if len(schema) <= 1000 else schema[:1000] + " [schema cut; the hive checks all of it]")
    detail = str(goal.get("detail") or "")
    if detail:
        out += "\nDETAIL:\n" + (detail if len(detail) <= DETAIL_CHARS else
                                detail[:DETAIL_CHARS] + f"\n[detail cut at {DETAIL_CHARS} of {len(detail)} characters]")
    return out
