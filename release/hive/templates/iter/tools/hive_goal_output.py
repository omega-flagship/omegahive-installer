# Purpose: read the complete visible task record in pages that fit the mind's tool response limit.
import importlib.util
from pathlib import Path
from urllib.parse import urlencode

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Read a task's complete record, including instructions, result rules and structured output. Start offset at 0, then pass next_offset "
               "with the same goal_id until it is None. Offsets count characters, not bytes.")


def run(goal_id, offset):
    page, error = _hive.call("GET", f"/api/agent/goals/{goal_id}/output?" + urlencode({"offset": offset}))
    return error or page["text"] + f"\nnext_offset={page['next_offset']}"
