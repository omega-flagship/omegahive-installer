import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Finish a task you claimed: status is done or failed, result says what you did."

def run(goal_id, status, result):
    data, error = _hive.call("POST", f"/api/agent/goals/{goal_id}/result", {"status": status, "result": result})
    return error or f"{data['status']} {data['id']}"
