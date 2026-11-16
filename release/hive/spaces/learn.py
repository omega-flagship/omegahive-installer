"""Track records: a flow routine's runs as evidence, counted by lib_learn.metta.

A routine is one flow artifact at one revision.  Each of its runs becomes
``(Run "<id>" STATUS)`` and lib_learn.metta's ``hive-track-record`` counts them
under GoalChainer v2's promotion, ``(Trials N) (Threshold THETA)``: from r done
and s failed runs, f = r/(r+s) and c = (r+s)/(r+s+2), as GoalChainer's SNARS cut
computes them, and the record is ``established`` once no run is open, at least
N runs finished done or failed, and the belief f*c exceeds THETA.

The hive's bar is GoalChainer's own, 3 runs and 0.5.  A caller may ask for a
stricter bar but never a looser one, so a routine can't lower its own bar, and
the threshold stays below 1, which the belief r/(r+s+2) never reaches.

A run's cost is the usage spent on its goals (``flow_steps.goal_id``).  Usage
rows name the agent that spent, not the goal it was spent on, so until the
usage table has a ``goal_id`` column nothing attributes cost to a run: every
run's cost reads ``None`` and ``cost_missing`` names ``usage.goal_id``.
"""

from __future__ import annotations

import math
import pathlib
import threading
import weakref

from . import sexpr

LIB_LEARN = pathlib.Path(__file__).resolve().with_name("lib_learn.metta")
COST_FIELD = "usage.goal_id"

# GoalChainer declares (gc-track-promotion (Trials 3) (Threshold 0.5)) for its proven procedures
# (OmegaClaw-GoalChainer 5c6ecda6, examples/planning/task-control-proven.procedures.metta:57).  The hive takes those
# values as its floor, so publishing a new revision can't lower a routine's bar.
TRIALS = 3
THRESHOLD = 0.5

_loaded = weakref.WeakSet()   # interpreters holding lib_learn; loading twice would answer every call twice
_load_lock = threading.Lock()


def check_promotion(trials, threshold):
    """GoalChainer's bounds on a promotion, floored at the hive's bar: Trials an integer of at least TRIALS, Threshold
    a finite number from THRESHOLD up to but not including 1."""
    if isinstance(trials, bool) or not isinstance(trials, int) or trials < TRIALS:
        raise ValueError(f"Trials must be an integer of at least the hive's {TRIALS}, not {trials!r}")
    if (isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold)
            or not THRESHOLD <= threshold < 1):
        raise ValueError(f"Threshold must be a number from the hive's {THRESHOLD} up to but not including 1, "
                         f"not {threshold!r}")


def runs(db, artifact_id, revision):
    """The routine's runs, oldest first, each with the cost and tokens its goals' usage carries, and the usage field
    attribution lacks: both None per run, and COST_FIELD, while usage has no goal_id column; else real sums and None."""
    rows = db.all("SELECT id, status, created_at FROM flow_runs WHERE artifact_id=? AND revision=? "
                  "ORDER BY created_at, id", (artifact_id, revision))
    attributed = "goal_id" in {c["name"] for c in db.all("PRAGMA table_info(usage)")}
    out = []
    for row in rows:
        cost = tokens = None
        if attributed:
            spent = db.one("SELECT COALESCE(SUM(u.cost_usd), 0) AS cost, "
                           "COALESCE(SUM(u.prompt_tokens + u.completion_tokens), 0) AS tokens "
                           "FROM usage u JOIN flow_steps s ON s.goal_id = u.goal_id WHERE s.run_id=?", (row["id"],))
            cost, tokens = float(spent["cost"]), int(spent["tokens"])
        out.append({"id": row["id"], "status": row["status"], "created_at": row["created_at"],
                    "cost_usd": cost, "tokens": tokens})
    return out, (None if attributed else COST_FIELD)


def _load(spaces):
    interp = spaces._interp
    with _load_lock:
        if interp not in _loaded:
            spaces.run(LIB_LEARN.read_text(encoding="utf-8"))
            _loaded.add(interp)


def track_record(db, spaces, artifact_id, revision, trials=TRIALS, threshold=THRESHOLD):
    """The routine's track record under (Trials trials) (Threshold threshold), with its runs and cost per run."""
    check_promotion(trials, threshold)
    rows, missing = runs(db, artifact_id, revision)
    _load(spaces)
    evidence = " ".join(sexpr.render(["Run", sexpr.Str(r["id"]), sexpr.safe_symbol(r["status"])]) for r in rows)
    answer = spaces.run_one(f"!(hive-track-record (Trials {trials}) (Threshold {float(threshold)!r}) ({evidence}))")
    match answer:
        case ["Track", ["Runs", done, failed, open_], ["stv", f, c], status,
              ("Established" | "NotEstablished") as verdict]:
            pass
        case _:
            raise sexpr.SexprError(f"hive-track-record answered {answer!r}")
    finished = [r["cost_usd"] for r in rows if r["status"] in ("done", "failed") and r["cost_usd"] is not None]
    return {"artifact_id": artifact_id, "revision": revision, "trials": trials, "threshold": threshold,
            "done": done, "failed": failed, "open": open_, "f": round(float(f), 6), "c": round(float(c), 6),
            "status": status, "established": verdict == "Established",
            "cost_usd_per_run": sum(finished) / len(finished) if finished else None, "cost_missing": missing,
            "runs": rows}
