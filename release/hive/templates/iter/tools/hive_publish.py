import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Share a belief with your swarm. statement is MeTTa, e.g. (--> sky blue); f = how true (0-1); c = confidence (0-1, exclusive)."

def run(statement, f, c):
    result, error = _hive.call("POST", "/api/agent/publish", {"statement": statement, "f": float(f), "c": float(c)})
    return error or f"published: {result['outcome']} {result['statement']}"
