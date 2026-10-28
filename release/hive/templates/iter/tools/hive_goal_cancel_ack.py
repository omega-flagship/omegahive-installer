import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Acknowledge that a cancelled task (g_...) you held or were assigned has stopped."


def run(goal_id):
    goal, error = _hive.call("POST", f"/api/agent/goals/{goal_id}/cancel-ack", {})
    return error or f"cancel acknowledged {goal['id']}"
