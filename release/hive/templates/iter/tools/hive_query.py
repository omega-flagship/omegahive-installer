import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Search your swarm commons with a MeTTa pattern, e.g. (Current (--> sky $x) $tv $stamp)."

def run(pattern):
    result, error = _hive.call("POST", "/api/agent/query", {"pattern": pattern})
    return error or (" | ".join(result["results"][:20]) or "no matches")
