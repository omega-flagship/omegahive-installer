import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Claim a swarm task by id (g_...) so nobody duplicates the work."

def run(goal_id):
    result, error = _hive.call("POST", f"/api/agent/goals/{goal_id}/claim")
    return error or f"claimed {result['id']}: {result['title']}"
