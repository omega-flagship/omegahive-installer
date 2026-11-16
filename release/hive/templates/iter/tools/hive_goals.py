# Purpose: show current tasks and recent completed work, with a route to the full task history.
import importlib.util
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Your tasks first, then open tasks and recent completed work. Use hive_goal_history to search older tasks "
               "by words or artifact id, hive_goal_get to read their results, and hive_goal_continue to carry work on.")


def _line(g):
    return f"{g['id']} {g['status']} p={g['priority']:.2f} {g['title']}"


def run():
    me = os.environ.get("HIVE_AGENT_ID", "")
    mine = []
    for status in ("claimed", "waiting"):
        held, error = _hive.call("GET", f"/api/agent/goals?status={status}")
        if error:
            return error
        mine += [g for g in held or [] if me and me in (g.get("claimed_by"), g.get("assignee"))]
    open_goals, error = _hive.call("GET", "/api/agent/goals?status=open")
    if error:
        return error
    mine += [g for g in open_goals or [] if me and g.get("assignee") == me]
    rest = [g for g in open_goals or [] if g not in mine]
    page, error = _hive.call("GET", "/api/agent/goals/history")
    if error:
        return error
    done = " | ".join(f"{g['id']} {g['updated_at']} {g['title']}: {str(g.get('result') or '')[:120]}" for g in page["goals"])
    blocks = [("yours: ", " | ".join(_line(g) for g in mine[:10]) or "none"),
              ("open: ", " | ".join(_line(g) for g in rest[:20]) or "none"), ("done: ", done or "none")]
    return " || ".join(label + text[:1500] + (" [list excerpt]" if len(text) > 1500 else "")
                       for label, text in blocks) + " (hive_goal_history searches older work)"
