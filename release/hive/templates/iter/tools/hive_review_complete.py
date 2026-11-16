import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ('Finish a review you hold. request_id is rq_...; result is JSON: {"recommendation": "proceed|revise|hold|unresolved", '
               '"rationale": "why", "finding_ids": [every finding you raised on it, or []], "coverage": ["what you checked"]}.')


def run(request_id, result):
    try:
        value = json.loads(result)
    except ValueError as exc:
        return f"HIVE-ERROR bad_request: give a JSON object ({exc}); the shape is in this tool's description"
    out, error = _hive.call("POST", f"/api/agent/requests/{request_id}/review-complete", value)
    if error:
        return error
    r = out["receipt"]
    return f"review complete {r['request_id']} findings={len(r['findings'])} recommendation={r['recommendation']}"
