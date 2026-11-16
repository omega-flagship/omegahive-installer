# Purpose: find completed swarm tasks by words or recorded artifact reference, with pages for older work.
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlencode

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Find completed tasks and what they produced. query is words or an artifact id, or empty for recent work. "
               "Start offset at 0, then use next_offset. Read a match with hive_goal_get; continue with hive_goal_continue.")


def run(query, offset):
    page, error = _hive.call("GET", "/api/agent/goals/history?" + urlencode({"q": query, "offset": offset}))
    if error:
        return error
    lines = []
    for goal in page["goals"]:
        lines.append(f"{goal['id']} done {goal['updated_at']} {goal['title'][:300]}\n"
                     f"result excerpt: {str(goal.get('result') or '')[:300]}\n"
                     f"data excerpt: {json.dumps(goal.get('result_data'), ensure_ascii=False)[:500]}")
    return ("\n".join(lines) or "none") + f"\nnext_offset={page['next_offset']} (same query); hive_goal_output reads complete output"
