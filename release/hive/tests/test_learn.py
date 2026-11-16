"""Track records from flow runs: hive/spaces/learn.py over a real hive database and the embedded PeTTa."""

import math

import pytest

from hive.core.db import Database
from hive.core.flows import SCHEMA
from hive.spaces import learn
from hive.spaces.service import SpaceService


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "hive.db")
    for sql in SCHEMA:
        database.execute(sql)
    return database


@pytest.fixture
def spaces(tmp_path):
    return SpaceService(tmp_path / "spaces")


def add_run(db, rid, status, artifact="flow-a", revision=1, at="2026-10-29T12:00:00Z", goals=()):
    db.execute("INSERT INTO flow_runs (id, artifact_id, revision, digest, swarm_id, actor, session_hash, client_key, "
               "status, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
               (rid, artifact, revision, "d", "s1", "ann", "h", f"k-{rid}", status, None, at, at))
    for n, goal in enumerate(goals):
        db.execute("INSERT INTO flow_steps VALUES (?,?,?,?,?)", (rid, f"t{n}", goal, "done", "{}"))


def add_usage(db, cost, tokens, goal=None):
    db.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost_usd, created_at, goal_id) "
               "VALUES (?,?,?,?,?,?,?)", ("agent-1", "m", tokens, 0, cost, "2026-10-29T12:00:01Z", goal))


def test_three_done_runs_establish_the_routine(db, spaces):
    for n in range(3):
        add_run(db, f"r{n}", "done", at=f"2026-10-29T12:00:0{n}Z")
    add_run(db, "other", "failed", revision=2)   # another revision is another routine
    record = learn.track_record(db, spaces, "flow-a", 1, trials=3, threshold=0.5)
    assert (record["done"], record["failed"], record["open"]) == (3, 0, 0)
    assert (record["f"], record["c"], record["status"], record["established"]) == (1.0, 0.6, "Holds", True)
    assert [r["id"] for r in record["runs"]] == ["r0", "r1", "r2"]


def test_three_done_and_one_failed_is_undecided_as_in_goalchainer(db, spaces):
    for rid, status in (("r0", "done"), ("r1", "failed"), ("r2", "done"), ("r3", "done")):
        add_run(db, rid, status)
    record = learn.track_record(db, spaces, "flow-a", 1)
    # b = 3/(3+1+2) = 0.5 does not exceed 0.5, and b + u = 5/6 does not fall short of it
    assert (record["f"], record["c"], record["status"], record["established"]) == (0.75, 0.666667, "Undecided", False)


def test_the_record_does_not_depend_on_the_order_of_its_runs(db, spaces):
    for n in range(200):
        add_run(db, f"a{n:03}", "done" if n < 100 else "failed", revision=1, at=f"2026-10-29T12:{n // 60:02}:{n % 60:02}Z")
        add_run(db, f"b{n:03}", "failed" if n < 100 else "done", revision=2, at=f"2026-10-29T12:{n // 60:02}:{n % 60:02}Z")
    first = learn.track_record(db, spaces, "flow-a", 1)
    second = learn.track_record(db, spaces, "flow-a", 2)
    assert (first["f"], first["c"], first["status"]) == (second["f"], second["c"], second["status"])
    assert (first["f"], first["c"], first["status"]) == (0.5, 0.990099, "Undecided")


def test_confidence_keeps_growing_past_a_hundred_runs(db, spaces):
    for n in range(150):
        add_run(db, f"r{n:03}", "done", at=f"2026-10-29T12:{n // 60:02}:{n % 60:02}Z")
    record = learn.track_record(db, spaces, "flow-a", 1, threshold=0.99)
    assert (record["c"], record["status"], record["established"]) == (0.986842, "Undecided", False)
    for n in range(150, 250):
        add_run(db, f"r{n:03}", "done", at=f"2026-10-29T13:{(n - 150) // 60:02}:{n % 60:02}Z")
    record = learn.track_record(db, spaces, "flow-a", 1, threshold=0.99)
    assert (record["c"], record["status"], record["established"]) == (0.992063, "Holds", True)


def test_without_usage_goal_id_no_cost_is_attributed(db, spaces):
    add_run(db, "r0", "done", goals=("g0",))
    record = learn.track_record(db, spaces, "flow-a", 1)
    assert record["cost_missing"] == "usage.goal_id"
    assert record["cost_usd_per_run"] is None
    assert record["runs"][0]["cost_usd"] is None and record["runs"][0]["tokens"] is None


def test_an_open_run_or_too_few_trials_keep_the_routine_unestablished(db, spaces):
    add_run(db, "r0", "done")
    add_run(db, "r1", "done")
    assert learn.track_record(db, spaces, "flow-a", 1, trials=3, threshold=0.5)["established"] is False
    add_run(db, "r2", "done")
    add_run(db, "r3", "running")
    record = learn.track_record(db, spaces, "flow-a", 1, trials=3, threshold=0.5)
    assert (record["open"], record["status"], record["established"]) == (1, "Holds", False)


def test_failures_fail_the_record_and_cancelled_runs_are_no_trial(db, spaces):
    for rid, status in (("r0", "failed"), ("r1", "failed"), ("r2", "done"), ("r3", "failed"), ("r4", "failed"),
                        ("r5", "cancelled")):
        add_run(db, rid, status)
    record = learn.track_record(db, spaces, "flow-a", 1, trials=3, threshold=0.5)
    assert (record["done"], record["failed"], record["open"]) == (1, 4, 0)
    # b + u = (1+2)/(1+4+2) = 3/7, short of 0.5
    assert (record["f"], record["c"], record["status"], record["established"]) == (0.2, 0.714286, "Fails", False)


def test_cost_per_run_once_usage_names_its_goal(db, spaces):
    db.execute("ALTER TABLE usage ADD COLUMN goal_id TEXT")
    add_run(db, "r0", "done", goals=("g0", "g1"), at="2026-10-29T12:00:00Z")
    add_run(db, "r1", "failed", goals=("g2",), at="2026-10-29T12:00:01Z")
    add_run(db, "r2", "running", goals=("g3",), at="2026-10-29T12:00:02Z")
    add_usage(db, 0.25, 100, "g0")
    add_usage(db, 0.5, 40, "g1")
    add_usage(db, 0.25, 10, "g2")
    add_usage(db, 1.0, 999, "g3")      # an open run's spend is its own, not the per-run figure's
    add_usage(db, 9.0, 999, "elsewhere")
    add_usage(db, 9.0, 999)
    record = learn.track_record(db, spaces, "flow-a", 1)
    assert record["cost_missing"] is None
    assert [(r["id"], r["cost_usd"], r["tokens"]) for r in record["runs"]] == [
        ("r0", 0.75, 140), ("r1", 0.25, 10), ("r2", 1.0, 999)]
    assert record["cost_usd_per_run"] == 0.5


def test_no_runs_is_undecided(db, spaces):
    record = learn.track_record(db, spaces, "flow-a", 1)
    assert (record["done"], record["status"], record["established"], record["cost_usd_per_run"]) == (0, "Undecided", False, None)


def test_the_library_loads_once(db, spaces, tmp_path):
    learn.track_record(db, spaces, "flow-a", 1)
    learn.track_record(db, SpaceService(tmp_path / "spaces-2"), "flow-a", 1)
    assert spaces.run("!(hive-track-cut (stv 1.0 0.75) 0.5)") == ["Holds"]


@pytest.mark.parametrize("bar", ["(Trials 2) (Threshold 0.5)", "(Trials 3) (Threshold 0.49)",
                                 "(Trials 3) (Threshold 1.0)"])
def test_the_metta_entry_holds_the_hives_bar(db, spaces, bar):
    learn.track_record(db, spaces, "flow-a", 1)   # loads lib_learn
    assert spaces.run_one(f"!(hive-track-record {bar} ((Run \"r0\" done)))")[0] == "Error"


def test_the_metta_entry_takes_the_hives_bar_and_a_stricter_one(db, spaces):
    learn.track_record(db, spaces, "flow-a", 1)
    for bar in ("(Trials 3) (Threshold 0.5)", "(Trials 4) (Threshold 0.9)"):
        assert spaces.run_one(f"!(hive-track-record {bar} ())")[0] == "Track"


def test_the_hives_bar_is_the_default_and_a_stricter_bar_is_honoured(db, spaces):
    for n in range(3):
        add_run(db, f"r{n}", "done", at=f"2026-10-29T12:00:0{n}Z")
    record = learn.track_record(db, spaces, "flow-a", 1)
    assert (record["trials"], record["threshold"], record["established"]) == (3, 0.5, True)
    assert learn.track_record(db, spaces, "flow-a", 1, trials=4)["established"] is False
    record = learn.track_record(db, spaces, "flow-a", 1, threshold=0.8)   # f*c is 0.6 and f*c + (1 - c) is 1.0
    assert (record["status"], record["established"]) == ("Undecided", False)


@pytest.mark.parametrize("trials, threshold, message", [
    (2, 0.5, "Trials must be an integer of at least the hive's 3, not 2"),
    (0, 0.5, "Trials must be an integer of at least the hive's 3, not 0"),
    (3.0, 0.5, "Trials must be an integer of at least the hive's 3, not 3.0"),
    (True, 0.5, "Trials must be an integer of at least the hive's 3, not True"),
    (3, 0.4, "Threshold must be a number from the hive's 0.5 up to but not including 1, not 0.4"),
    (3, 0, "Threshold must be a number from the hive's 0.5 up to but not including 1, not 0"),
    (3, 1, "Threshold must be a number from the hive's 0.5 up to but not including 1, not 1"),
    (3, 1.0, "Threshold must be a number from the hive's 0.5 up to but not including 1, not 1.0"),
    (3, 1.5, "Threshold must be a number from the hive's 0.5 up to but not including 1, not 1.5"),
    (3, math.nan, "Threshold must be a number from the hive's 0.5 up to but not including 1, not nan"),
    (3, "half", "Threshold must be a number from the hive's 0.5 up to but not including 1, not 'half'"),
])
def test_promotion_bounds(db, spaces, trials, threshold, message):
    with pytest.raises(ValueError) as error:
        learn.track_record(db, spaces, "flow-a", 1, trials=trials, threshold=threshold)
    assert str(error.value) == message
