import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ('Finish a task that has a RESULT SCHEMA (see hive_goal_get): proposal is JSON that fits it exactly, '
               'e.g. {"answer": "...", "sources": ["src-1"]}. If the hive refuses, its reply says what does not fit.')


def run(goal_id, proposal):
    goal, error = _hive.call("GET", f"/api/agent/goals/{goal_id}")
    if error:
        return error
    try:
        value = json.loads(proposal)
    except ValueError:
        value = {"text": proposal}   # as the omega skill does: with a result schema the hive refuses this and says why
    done, error = _hive.call("POST", f"/api/agent/goals/{goal['id']}/result", {
        "status": "done", "result": str(proposal)[:4000],
        "data": {"binding_digest": goal.get("binding_digest"), "proposal": value}})
    return error or f"proposed {done['id']} {done['status']}"
