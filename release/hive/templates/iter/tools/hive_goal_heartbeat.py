import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Keep holding a task you claimed (g_...) while you work on it; a held task whose lease runs out is reopened for others."


def run(goal_id):
    goal, error = _hive.call("POST", f"/api/agent/goals/{goal_id}/heartbeat", {})
    return error or f"held {goal['id']} {goal['status']} lease_until={goal.get('lease_until')}"
