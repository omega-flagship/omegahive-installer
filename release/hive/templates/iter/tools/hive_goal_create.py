import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Post a new task for your swarm. parent_id is none for a task of its own, or the id (g_...) of a task you "
               "hold to split it into smaller tasks. detail says what to do (may be empty).")


def run(parent_id, title, detail):
    payload = {"title": title, "detail": detail}
    if parent_id and parent_id.strip() not in ("none", "-"):
        payload["parent_id"] = parent_id.strip()
    result, error = _hive.call("POST", "/api/agent/goals", payload)
    return error or f"created {result['id']}: {result['title']}"
