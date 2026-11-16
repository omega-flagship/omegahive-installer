import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ('Raise one finding on a review request you hold. finding is JSON: {"request_id": "rq_...", "mandate": {"id": "...", '
               '"version": "..."}, "target": {"step": "s1"} or {"whole": true}, "severity": "blocker|major|minor|note", '
               '"recommendation": "what to change and why", "evidence_refs": []}. A refusal shows a corrected example.')


def run(finding):
    try:
        value = json.loads(finding)
    except ValueError as exc:
        return f"HIVE-ERROR bad_request: give a JSON object ({exc}); the shape is in this tool's description"
    out, error = _hive.call("POST", "/api/agent/findings", value)
    return error or f"finding {out['id']} {out['severity']} on r{out['raised_on']['revision']}"
