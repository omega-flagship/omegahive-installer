# Purpose: read a task's instructions, result rules and recorded output before working or continuing it.
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


def read(goal_id, reserve=0):
    """The task read run returns, in reserve fewer characters when a caller prints a line before it."""
    goal, error = _hive.call("GET", f"/api/agent/goals/{goal_id}")
    if error:
        return error
    out = (f"{goal['id']} {goal['status']} {goal['title'][:300]} assignee={goal.get('assignee')} "
           f"claimed_by={goal.get('claimed_by')} deadline={goal.get('deadline_at')}")
    cut = False   # whether this read leaves part of the record out
    if goal.get("binding"):
        binding = json.dumps(goal["binding"])
        cut = len(binding) > 400
        out += "\nBINDING: " + binding[:400] + (" [binding excerpt]" if len(binding) > 400 else "")
    if goal.get("result_schema"):
        schema = json.dumps(goal["result_schema"], separators=(",", ":"))
        cut |= len(schema) > 1000
        out += "\nRESULT SCHEMA (finish with hive_goal_propose, JSON that fits it exactly): " + (
            schema if len(schema) <= 1000 else schema[:1000] + " [schema cut; the hive checks all of it]")
    detail = str(goal.get("detail") or "")
    has_result = goal.get("result") or goal.get("result_data") is not None
    room = min(DETAIL_CHARS, max(0, 4400 - reserve - len(out) - (1000 if has_result else 0)))
    if detail:
        cut |= len(detail) > room
        out += "\nDETAIL:\n" + (detail if len(detail) <= room else
                                detail[:room] + f"\n[detail cut at {room} of {len(detail)} characters]")
    if has_result:
        result = json.dumps({"result": goal.get("result"), "result_data": goal.get("result_data")}, ensure_ascii=False)
        # Iter keeps 5000 characters per tool result. Reserve space for an explicit truncation marker.
        room = max(0, 4700 - reserve - len(out))
        cut |= len(result) > room
        out += "\nRESULT:\n" + result[:room] + ("\n[result excerpt]" if len(result) > room else "")
    return out + (f"\nhive_goal_output {goal_id} 0 reads the complete task record in pages" if cut else "")


def run(goal_id):
    return read(goal_id)
