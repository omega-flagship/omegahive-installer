"""Renamed Lab metric names, case titles, groups and series: the one source both the bench and the host read.

History and Compare pair metrics across runs by name, so a shown name cannot simply change: old runs
would stop lining up with new ones. Each rename keeps its old name here.

- Where a metric is made (``harness.metric``), a renamed metric declares ``legacy_names: [old]``.
- Where the host serves stored runs (``core/lab.py``), an old name comes out as the new one with
  ``renamed_from: old``. Stored rows are never rewritten; a record with current names comes out unchanged.

Old names are the only place the retired wording may appear in bench code: "dot" (minds wording, 2026-10-12) and
"goal"/"subgoal" (host-wording r1, 2026-10-13: work is Motivations and Tasks). The new task names are the ones the Lab
already shows for them (uifix-r1), so the host and the Lab now say the same thing.
"""

from __future__ import annotations

# old name -> current name. A current name is never itself an old name (no chains).
METRIC_RENAMES = {
    "memory per dot": "memory per mind",
    "idle model calls per dot-day": "idle model calls per mind-day",
    "dot stayed up": "mind stayed up",
    "dots restored": "minds restored",
    "dots in error": "minds in error",
    "dots connected": "minds connected",
    "dots with errors": "minds with errors",
    "finished by second dot": "finished by second mind",
    "goals with two winners": "tasks claimed twice",
    "goals with a winner": "tasks with one owner",
    "subgoals accepted": "subtasks accepted",
}

# Case titles are shown, not keys (History and Compare key cases by id), but old runs read better renamed.
CASE_RENAMES = {
    "Dot crash recovery": "Mind crash recovery",
    "Goal claim race": "Task claim race",
    "Abandoned goal recovery": "Abandoned task recovery",
    "Subgoal explosion": "Subtask explosion",
}

# A case's group and a series' name and x axis are shown, never paired across runs; old runs are served renamed too.
GROUP_RENAMES = {
    "goals": "tasks",
}
SERIES_RENAMES = {
    "winners per goal": "owners per task",
    "goal state (0 open, 1 claimed, 2 waiting, 4 done)": "task state (0 open, 1 claimed, 2 waiting, 4 done)",
}
AXIS_RENAMES = {
    "goal": "task",
}

LEGACY_METRIC_NAMES: dict[str, list[str]] = {}
for _old, _new in METRIC_RENAMES.items():
    LEGACY_METRIC_NAMES.setdefault(_new, []).append(_old)

MISSED = "missed target: "


def legacy_metric_names(name):
    """The old names a current metric name replaced, else []."""
    return list(LEGACY_METRIC_NAMES.get(name, ()))


def current_metric(metric):
    """A stored metric as served: under its current name, with ``renamed_from``. Current names pass as they are."""
    old = metric.get("name")
    new = METRIC_RENAMES.get(old)
    if new is None:
        return metric
    return {**metric, "name": new, "renamed_from": old, "legacy_names": legacy_metric_names(new)}


def current_case_name(name):
    """(current title, old title or None) for a stored case title."""
    new = CASE_RENAMES.get(name)
    return (name, None) if new is None else (new, name)


def current_group(group):
    """A stored case group as served (groups are labels, not keys)."""
    return GROUP_RENAMES.get(group, group)


def current_series(s):
    """A stored series as served: its name and x axis in current words, with ``renamed_from`` when the name changed."""
    name, x = s.get("name"), s.get("x")
    out = s
    if x in AXIS_RENAMES:
        out = {**out, "x": AXIS_RENAMES[x]}
    if name in SERIES_RENAMES:
        out = {**out, "name": SERIES_RENAMES[name], "renamed_from": name}
    return out


def current_message(message):
    """A stored "missed target: a, b" message names metrics; serve it with their current names."""
    if not isinstance(message, str) or not message.startswith(MISSED):
        return message
    names = message[len(MISSED):].split(", ")
    return MISSED + ", ".join(METRIC_RENAMES.get(n, n) for n in names)
