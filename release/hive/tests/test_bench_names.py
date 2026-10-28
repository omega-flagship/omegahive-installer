"""Lab wording: minds are called minds, and runs stored under the old "dot" names still line up.

- Renamed metric names keep their old name in one place (hive/bench/names.py); old stored runs are served
  under the new name with ``renamed_from``, new runs come out as they are, and History pairs the two.
- A wording guard: no shown bench string, and none of the host docs, call a mind a "dot".
"""

import ast
import json
import pathlib
import re

from hive.bench import names
from hive.bench.harness import metric
from hive.core import db
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

HIVE = pathlib.Path(__file__).resolve().parents[1]
BENCH = HIVE / "bench"
HOST_DOCS = ["README.md", "API.md", "PROGRAMS.md", "JOINING.md"]
DOT_WORD = re.compile(r"\bdots?\b|\bdot['’]s\b", re.IGNORECASE)

# Uses of the word that do not mean a mind, each pinned to the exact text.
DOC_ALLOWED = [
    "no dots in the stem",                       # PROGRAMS.md: "." characters in a file name
    "formerly titled 'Dot program contract'",    # PROGRAMS.md: the old title, named on purpose
    "hive-share-offer dot space minutes",        # API.md: the skill's declared parameter is named `dot`
                                                 # (modules/hive/signatures.metta), so the doc keeps it
]


def dot_words(text, allowed=()):
    """Every place `text` uses "dot"/"dots" as a word, after removing the allowed phrases and old names."""
    for phrase in list(allowed) + [f"`{old}`" for old in [*names.METRIC_RENAMES, *names.CASE_RENAMES]]:
        text = text.replace(phrase, "")
    return [m.group(0) for m in DOT_WORD.finditer(text)]


def bench_strings(source):
    """Every string constant in a bench module: metric names, case titles, notes, descriptions, labels."""
    return [node.value for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Constant)
            and isinstance(node.value, str)]


def bench_sources():
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(BENCH.glob("*.py")) if p.name != "names.py"}


def bench_offences(sources):
    return [(name, s) for name, source in sources.items() for s in bench_strings(source) if dot_words(s)]


# ---- the wording guard -------------------------------------------------------------------------------

def test_no_shown_bench_string_calls_a_mind_a_dot():
    assert bench_offences(bench_sources()) == []


def test_the_bench_guard_catches_a_reintroduced_dot():
    sources = bench_sources()
    assert 'metric("memory per mind"' in sources["ops.py"]
    sources["ops.py"] = sources["ops.py"].replace('metric("memory per mind"', 'metric("memory per dot"')
    assert ("ops.py", "memory per dot") in bench_offences(sources)
    sources = bench_sources()
    sources["catalog.py"] = sources["catalog.py"].replace("separate memory per mind", "separate memory per dot")
    assert any(name == "catalog.py" for name, _ in bench_offences(sources))


def test_no_host_doc_calls_a_mind_a_dot():
    found = {doc: dot_words((HIVE / doc).read_text(encoding="utf-8"), DOC_ALLOWED) for doc in HOST_DOCS}
    assert found == {doc: [] for doc in HOST_DOCS}


def test_the_doc_guard_catches_a_reintroduced_dot():
    api = (HIVE / "API.md").read_text(encoding="utf-8")
    assert "## Timed sharing between minds" in api
    assert dot_words(api.replace("## Timed sharing between minds", "## Timed sharing between dots"), DOC_ALLOWED) == ["dots"]
    readme = (HIVE / "README.md").read_text(encoding="utf-8")
    assert dot_words(readme + "\nmemory per dot\n", DOC_ALLOWED) == ["dot"]
    # an allowed phrase only covers itself
    assert dot_words("hive-share-offer dot space minutes; open it to a dot", DOC_ALLOWED) == ["dot"]


def test_the_guard_leaves_unrelated_dots_alone():
    assert dot_words("OmegaDot and docs/omegadots/PLAN.md, version 1.2, dot_rss") == []


# ---- one source for the renames ------------------------------------------------------------------------

def test_renames_are_one_flat_mapping_and_every_new_name_is_made_by_the_bench():
    assert not set(names.METRIC_RENAMES.values()) & set(names.METRIC_RENAMES)       # no chains
    assert not set(names.CASE_RENAMES.values()) & set(names.CASE_RENAMES)
    for new in [*names.METRIC_RENAMES.values(), *names.CASE_RENAMES.values()]:
        assert not dot_words(new)
    every = [s for source in bench_sources().values() for s in bench_strings(source)]
    for old, new in [*names.METRIC_RENAMES.items(), *names.CASE_RENAMES.items()]:
        assert new in every, new                 # the bench emits the new name
        assert old not in every, old             # and the old one only lives in names.py


def test_a_renamed_metric_declares_its_legacy_name_where_it_is_made():
    made = metric("memory per mind", 512, "MB", "lower", 600)
    assert made["legacy_names"] == ["memory per dot"] and made["ok"] is True
    assert "legacy_names" not in metric("server memory", 100, "MB", "lower", 400)


def test_api_md_lists_every_rename():
    api = (HIVE / "API.md").read_text(encoding="utf-8")
    for old, new in names.METRIC_RENAMES.items():
        assert f"| `{old}` | `{new}` |" in api, old
    for old, new in names.CASE_RENAMES.items():
        assert f"| `{old}` (case title) | `{new}` |" in api, old


# ---- old runs come out under the new names; stored rows stay as written ------------------------------------

OLD_IDLE = [
    {"name": "memory per dot", "value": 480.0, "unit": "MB", "better": "lower", "target": 600, "ok": True},
    {"name": "server memory", "value": 120.0, "unit": "MB", "better": "lower", "target": 400, "ok": True},
]


def _store_run(client, cases, started_at):
    """A finished bench-ops run stored through the Lab's own recording path (synthetic values)."""
    lab = client.app.state.hive.lab
    run = {"id": db.new_id("run"), "suite": "bench-ops", "status": "running", "started_at": started_at, "commit_sha": None}
    lab.db.insert("lab_runs", run)
    for case in cases:
        lab._record_case(run["id"], dict({"group": "resources", "dimension": "resources", "status": "passed",
                                          "duration_ms": 1.0, "notes": "synthetic", "series": []}, **case))
    lab.db.update("lab_runs", run["id"], {"status": "passed", "finished_at": db.now()})
    return run["id"]


def _old_run(client):
    return _store_run(client, [
        {"id": "bench-ops::idle", "name": "Resources at idle", "metrics": OLD_IDLE},
        {"id": "bench-ops::crash", "name": "Dot crash recovery", "dimension": "reliability", "status": "failed",
         "message": "missed target: dots restored, recovery time",
         "metrics": [{"name": "dots restored", "value": 0, "unit": "", "better": "equal", "target": 1, "ok": False},
                     {"name": "recovery time", "value": 75, "unit": "s", "better": "lower", "target": 60,
                      "ok": False}]},
    ], "2026-10-01T09:00:00.000Z")


def _new_run(client):
    return _store_run(client, [
        {"id": "bench-ops::idle", "name": "Resources at idle",
         "metrics": [metric("memory per mind", 470, "MB", "lower", 600), metric("server memory", 118, "MB", "lower", 400)]},
        {"id": "bench-ops::crash", "name": "Mind crash recovery", "dimension": "reliability",
         "metrics": [metric("minds restored", 1, "", "equal", 1), metric("recovery time", 20, "s", "lower", 60)]},
    ], "2026-10-12T09:00:00.000Z")


def test_an_old_record_is_served_under_the_new_names_and_left_as_stored(client):
    run_id = _old_run(client)
    stored = {r["case_id"]: r for r in client.app.state.hive.db.all("SELECT * FROM lab_cases WHERE run_id = ?", (run_id,))}
    served = {c["id"]: c for c in client.get(f"/api/lab/runs/{run_id}").json()["cases"]}

    idle = served["bench-ops::idle"]
    assert idle["metrics"][0] == dict(OLD_IDLE[0], name="memory per mind", renamed_from="memory per dot",
                                      legacy_names=["memory per dot"])
    assert idle["metrics"][1] == OLD_IDLE[1] and "renamed_from" not in idle
    crash = served["bench-ops::crash"]
    assert crash["name"] == "Mind crash recovery" and crash["renamed_from"] == "Dot crash recovery"
    assert crash["metrics"][0]["name"] == "minds restored" and crash["metrics"][0]["renamed_from"] == "dots restored"
    assert crash["message"] == "missed target: minds restored, recovery time"

    # stored data is never rewritten in place
    assert json.loads(stored["bench-ops::idle"]["metrics"]) == OLD_IDLE
    assert stored["bench-ops::crash"]["name"] == "Dot crash recovery"
    assert stored["bench-ops::crash"]["message"] == "missed target: dots restored, recovery time"
    again = client.app.state.hive.db.all("SELECT * FROM lab_cases WHERE run_id = ?", (run_id,))
    assert {r["case_id"]: r for r in again} == stored

    card = client.get("/api/lab/scorecard").json()
    shown = [h["name"] for d in card for h in d["highlights"]]
    assert "memory per mind" in shown and "memory per dot" not in shown


def test_a_new_record_comes_out_exactly_as_stored(client):
    run_id = _new_run(client)
    stored = {r["case_id"]: r for r in client.app.state.hive.db.all("SELECT * FROM lab_cases WHERE run_id = ?", (run_id,))}
    served = {c["id"]: c for c in client.get(f"/api/lab/runs/{run_id}").json()["cases"]}
    for case_id, row in stored.items():
        assert served[case_id]["metrics"] == json.loads(row["metrics"])
        assert served[case_id]["name"] == row["name"] and "renamed_from" not in served[case_id]
        assert all("renamed_from" not in m for m in served[case_id]["metrics"])
    assert served["bench-ops::idle"]["metrics"][0]["legacy_names"] == ["memory per dot"]


def test_history_pairs_an_old_run_with_a_new_run_under_one_name(client):
    old_id, new_id = _old_run(client), _new_run(client)
    history = client.get("/api/lab/history/bench-ops").json()
    by_key = {(m["case_id"], m["metric"]): m for m in history["metrics"]}
    assert not any(names.METRIC_RENAMES.get(metric_name) for _, metric_name in by_key)   # no old name left

    memory = by_key[("bench-ops::idle", "memory per mind")]
    assert [p["run_id"] for p in memory["points"]] == [old_id, new_id]
    assert memory["points"][0]["renamed_from"] == "memory per dot" and "renamed_from" not in memory["points"][1]
    assert memory["legacy_names"] == ["memory per dot"] and memory["case"] == "Resources at idle"
    restored = by_key[("bench-ops::crash", "minds restored")]
    assert [p["value"] for p in restored["points"]] == [0, 1] and restored["case"] == "Mind crash recovery"
    unchanged = by_key[("bench-ops::idle", "server memory")]
    assert len(unchanged["points"]) == 2 and "legacy_names" not in unchanged

    # Compare pairs two runs' cases by id and their metrics by name: the names now match
    old = {c["id"]: c for c in client.get(f"/api/lab/runs/{old_id}").json()["cases"]}
    new = {c["id"]: c for c in client.get(f"/api/lab/runs/{new_id}").json()["cases"]}
    for case_id in new:
        assert [m["name"] for m in old[case_id]["metrics"]] == [m["name"] for m in new[case_id]["metrics"]]


# ---- host-wording r1: "goal"/"subgoal" measures became task measures, and still pair with old runs ------------------

OLD_RACE = [
    {"name": "goals with two winners", "value": 0.0, "unit": "", "better": "equal", "target": 0, "ok": True},
    {"name": "goals with a winner", "value": 24.0, "unit": "", "better": "equal", "target": 25, "ok": False},
]
OLD_RACE_SERIES = [{"name": "winners per goal", "unit": "", "kind": "bar", "x": "goal", "points": [[0, 1], [1, 2]]}]
OLD_STATE_SERIES = [{"name": "goal state (0 open, 1 claimed, 2 waiting, 4 done)", "unit": "", "kind": "step", "x": "event",
                     "points": [[0, 0], [1, 1]]}]


def _store_suite_run(client, suite, cases, started_at):
    lab = client.app.state.hive.lab
    run = {"id": db.new_id("run"), "suite": suite, "status": "running", "started_at": started_at, "commit_sha": None}
    lab.db.insert("lab_runs", run)
    for case in cases:
        lab._record_case(run["id"], dict({"dimension": "reliability", "status": "passed", "duration_ms": 1.0,
                                          "notes": "synthetic", "series": []}, **case))
    lab.db.update("lab_runs", run["id"], {"status": "passed", "finished_at": db.now()})
    return run["id"]


def test_the_task_renames_are_declared_where_the_measures_are_made():
    assert metric("tasks claimed twice", 0, "", "equal", 0)["legacy_names"] == ["goals with two winners"]
    assert metric("tasks with one owner", 25, "", "equal", 25)["legacy_names"] == ["goals with a winner"]
    assert metric("subtasks accepted", 12, "", "equal", 12)["legacy_names"] == ["subgoals accepted"]
    assert names.CASE_RENAMES["Subgoal explosion"] == "Subtask explosion"


def test_an_old_goal_run_is_served_in_task_words_and_left_as_stored(client):
    run_id = _store_suite_run(client, "bench-core", [
        {"id": "bench-core::claim_race", "name": "Goal claim race", "group": "goals", "status": "failed",
         "message": "missed target: goals with a winner", "metrics": OLD_RACE, "series": OLD_RACE_SERIES}], "2026-10-01T09:00:00.000Z")
    served = client.get(f"/api/lab/runs/{run_id}").json()["cases"][0]
    assert served["name"] == "Task claim race" and served["renamed_from"] == "Goal claim race"
    assert served["group"] == "tasks"
    assert [m["name"] for m in served["metrics"]] == ["tasks claimed twice", "tasks with one owner"]
    assert [m["renamed_from"] for m in served["metrics"]] == ["goals with two winners", "goals with a winner"]
    assert served["message"] == "missed target: tasks with one owner"
    assert served["series"] == [dict(OLD_RACE_SERIES[0], name="owners per task", x="task", renamed_from="winners per goal")]
    stored = client.app.state.hive.db.one("SELECT * FROM lab_cases WHERE run_id = ?", (run_id,))
    assert (stored["name"], stored["grp"]) == ("Goal claim race", "goals")
    assert json.loads(stored["metrics"]) == OLD_RACE and json.loads(stored["series"]) == OLD_RACE_SERIES


def test_history_pairs_an_old_subgoal_run_with_a_new_subtask_run(client):
    old_id = _store_suite_run(client, "bench-drift", [
        {"id": "bench-drift::subgoal_explosion", "name": "Subgoal explosion", "group": "goals",
         "metrics": [{"name": "subgoals accepted", "value": 12.0, "unit": "", "better": "equal", "target": 12, "ok": True}]},
        {"id": "bench-drift::abandoned_goal", "name": "Abandoned goal recovery", "group": "goals", "metrics": [],
         "series": OLD_STATE_SERIES}], "2026-10-01T09:00:00.000Z")
    new_id = _store_suite_run(client, "bench-drift", [
        {"id": "bench-drift::subgoal_explosion", "name": "Subtask explosion", "group": "tasks",
         "metrics": [metric("subtasks accepted", 12, "", "equal", 12)]}], "2026-10-13T09:00:00.000Z")
    by_key = {(m["case_id"], m["metric"]): m for m in client.get("/api/lab/history/bench-drift").json()["metrics"]}
    accepted = by_key[("bench-drift::subgoal_explosion", "subtasks accepted")]
    assert [p["run_id"] for p in accepted["points"]] == [old_id, new_id]
    assert accepted["points"][0]["renamed_from"] == "subgoals accepted" and accepted["case"] == "Subtask explosion"
    assert ("bench-drift::subgoal_explosion", "subgoals accepted") not in by_key
    old = {c["id"]: c for c in client.get(f"/api/lab/runs/{old_id}").json()["cases"]}
    assert old["bench-drift::abandoned_goal"]["series"][0]["name"].startswith("task state (0 open")
    assert old["bench-drift::abandoned_goal"]["name"] == "Abandoned task recovery"


def test_the_bench_emits_the_task_names():
    every = [s for source in bench_sources().values() for s in bench_strings(source)]
    for new in ["Task claim race", "Abandoned task recovery", "Subtask explosion", "tasks", "owners per task", "task",
                "task state (0 open, 1 claimed, 2 waiting, 4 done)"]:
        assert new in every, new
    for old in [*names.GROUP_RENAMES, *names.SERIES_RENAMES]:
        assert old not in every or old == "goals", old          # "goals" is still the table the bench lapses a lease in
