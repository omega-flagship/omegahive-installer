"""The Lab: run test suites and benchmarks from the UI and keep their history.

Each run is a child process (``python -m hive.bench run <suite>``) with its own
scratch data, so a benchmark never touches this hive's agents or commons.
Results stream back as ``lab.case`` events and are stored for history charts.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import threading
import time

from ..bench.catalog import BY_ID, SUITES
from ..bench.names import (current_case_name, current_group, current_message, current_metric, current_series,
                           legacy_metric_names)
from ..bench.protocol import parse
from .db import new_id, now

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCHEMA = """
CREATE TABLE IF NOT EXISTS lab_runs (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  duration_ms REAL, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, commit_sha TEXT, log TEXT
);
CREATE INDEX IF NOT EXISTS lab_runs_suite ON lab_runs(suite, started_at);
CREATE TABLE IF NOT EXISTS lab_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, case_id TEXT NOT NULL, name TEXT NOT NULL,
  grp TEXT NOT NULL, dimension TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, duration_ms REAL, message TEXT, notes TEXT,
  metrics TEXT NOT NULL, series TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lab_cases_run ON lab_cases(run_id, id);
"""
COUNT = {"passed": "passed", "failed": "failed", "skipped": "skipped", "error": "errors"}


def _commit():
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                              timeout=5).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


class Lab:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.db._conn.executescript(SCHEMA)
        columns = {r[1] for r in self.db._conn.execute("PRAGMA table_info(lab_cases)")}
        if "dimension" not in columns:
            self.db._conn.execute("ALTER TABLE lab_cases ADD COLUMN dimension TEXT NOT NULL DEFAULT ''")
        self.procs: dict[str, subprocess.Popen] = {}
        # Runs left "running" by a hive that stopped mid-run never finished.
        self.db.execute("UPDATE lab_runs SET status = 'cancelled' WHERE status = 'running'")

    # ---- reading ------------------------------------------------------------------------------

    def requirements(self):
        petta = pathlib.Path(self.hive.settings.petta_path)
        chroma = os.environ.get("HIVE_CHROMADB_LIB") or str(self.hive.settings.data_dir / "libs" / "petta_lib_chromadb")
        from ..bench import epistemic
        return {"petta": (petta / "run.sh").exists(), "chromadb": pathlib.Path(chroma, "lib_chromadb.metta").exists(),
                "epistemic-resolve": epistemic.available()}

    def suites(self):
        have = self.requirements()
        out = []
        for suite in SUITES:
            last = self.db.one("SELECT * FROM lab_runs WHERE suite = ? ORDER BY started_at DESC LIMIT 1", (suite["id"],))
            missing = [n for n in suite.get("needs", []) if not have.get(n)]
            out.append({k: suite[k] for k in ("id", "kind", "title", "description", "estimate_s")}
                       | {"needs": suite.get("needs", []), "missing": missing, "runnable": not missing,
                          "last_run": self.run_view(last) if last else None})
        return out

    def run_view(self, row):
        return {k: row[k] for k in ("id", "suite", "status", "started_at", "finished_at", "duration_ms", "passed",
                                    "failed", "skipped", "errors", "commit_sha")}

    def case_view(self, row):
        # Served under current names (hive/bench/names.py); the stored row is left as it was written.
        name, old_name = current_case_name(row["name"])
        view = {"run_id": row["run_id"], "id": row["case_id"], "name": name, "group": current_group(row["grp"]),
                "dimension": row["dimension"] or "correctness",
                "status": row["status"], "duration_ms": row["duration_ms"], "message": current_message(row["message"]),
                "notes": row["notes"], "metrics": [current_metric(m) for m in json.loads(row["metrics"])],
                "series": [current_series(s) for s in json.loads(row["series"])]}
        if old_name is not None:
            view["renamed_from"] = old_name
        return view

    def runs(self, suite=None, limit=50):
        sql, params = "SELECT * FROM lab_runs", []
        if suite:
            sql, params = sql + " WHERE suite = ?", [suite]
        return [self.run_view(r) for r in self.db.all(sql + " ORDER BY started_at DESC LIMIT ?", (*params, limit))]

    def run(self, run_id):
        row = self.db.one("SELECT * FROM lab_runs WHERE id = ?", (run_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no run {run_id}")
        cases = self.db.all("SELECT * FROM lab_cases WHERE run_id = ? ORDER BY id", (run_id,))
        return self.run_view(row) | {"log": row["log"] or "", "cases": [self.case_view(c) for c in cases]}

    def history(self, suite, limit=30):
        """Per-metric values across a suite's recent runs, oldest first, for trend charts."""
        runs = self.db.all("SELECT * FROM lab_runs WHERE suite = ? AND status != 'running' "
                           "ORDER BY started_at DESC LIMIT ?", (suite, limit))[::-1]
        points: dict[str, dict] = {}
        for run in runs:
            for case in self.db.all("SELECT case_id, name, metrics, status FROM lab_cases WHERE run_id = ?",
                                    (run["id"],)):
                for m in map(current_metric, json.loads(case["metrics"])):
                    # Keyed by the current name, so a run stored under an old name lines up with newer runs.
                    key = f"{case['case_id']}::{m['name']}"
                    title = current_case_name(case["name"])[0]
                    entry = points.setdefault(key, {"case_id": case["case_id"], "case": title,
                                                    "metric": m["name"], "unit": m.get("unit", ""),
                                                    "better": m.get("better"), "target": m.get("target"),
                                                    "points": []})
                    legacy = legacy_metric_names(m["name"])
                    if legacy:
                        entry["legacy_names"] = legacy
                    point = {"run_id": run["id"], "at": run["started_at"], "value": m["value"], "ok": m.get("ok")}
                    if "renamed_from" in m:
                        point["renamed_from"] = m["renamed_from"]
                    entry["points"].append(point)
        return {"suite": suite, "runs": [self.run_view(r) for r in runs], "metrics": list(points.values())}

    def scorecard(self):
        """Health per dimension, from the latest finished run of every suite."""
        dims: dict[str, dict] = {}
        for suite in SUITES:
            run = self.db.one("SELECT * FROM lab_runs WHERE suite = ? AND status NOT IN ('running', 'cancelled') "
                              "ORDER BY started_at DESC LIMIT 1", (suite["id"],))
            if run is None:
                continue
            for case in self.db.all("SELECT * FROM lab_cases WHERE run_id = ?", (run["id"],)):
                view = self.case_view(case)
                entry = dims.setdefault(view["dimension"], {"dimension": view["dimension"], "passed": 0, "failed": 0,
                                                            "skipped": 0, "errors": 0, "suites": set(),
                                                            "highlights": []})
                entry[COUNT.get(view["status"], "errors")] += 1
                entry["suites"].add(suite["id"])
                for m in view["metrics"]:
                    if m.get("target") is not None and len(entry["highlights"]) < 6:
                        entry["highlights"].append({"case": view["name"], "suite": suite["id"], **m})
        out = []
        for entry in dims.values():
            judged = entry["passed"] + entry["failed"] + entry["errors"]
            entry["score"] = round(entry["passed"] / judged, 4) if judged else None
            entry["suites"] = sorted(entry["suites"])
            out.append(entry)
        order = ["correctness", "accuracy", "latency", "efficiency", "resources", "power", "cost", "reliability",
                 "bias", "drift"]
        return sorted(out, key=lambda e: order.index(e["dimension"]) if e["dimension"] in order else 99)

    # ---- running ------------------------------------------------------------------------------

    def start(self, suite_id):
        suite = BY_ID.get(suite_id)
        if suite is None:
            raise self.hive.error(404, "not_found", f"no suite {suite_id}")
        if self.db.one("SELECT 1 FROM lab_runs WHERE suite = ? AND status = 'running'", (suite_id,)):
            raise self.hive.error(409, "already_running", f"{suite['title']} is already running")
        missing = [n for n in suite.get("needs", []) if not self.requirements().get(n)]
        if missing:
            raise self.hive.error(400, "missing_requirements", f"{suite['title']} needs {', '.join(missing)}")
        row = {"id": new_id("run"), "suite": suite_id, "status": "running", "started_at": now(),
               "commit_sha": _commit()}
        self.db.insert("lab_runs", row)
        self._emit_run(row["id"])
        threading.Thread(target=self._execute, args=(row["id"], suite_id), daemon=True).start()
        return self.run(row["id"])

    def cancel(self, run_id):
        proc = self.procs.get(run_id)
        if proc is None:
            raise self.hive.error(409, "not_running", "that run is not running")
        proc.terminate()
        return {"cancelling": True}

    def _emit_run(self, run_id):
        row = self.db.one("SELECT * FROM lab_runs WHERE id = ?", (run_id,))
        self.hive.events.publish("lab.run", run=self.run_view(row))

    def _env(self):
        env = dict(os.environ, PETTA_PATH=str(self.hive.settings.petta_path), PYTHONUNBUFFERED="1")
        chroma = self.hive.settings.data_dir / "libs" / "petta_lib_chromadb"
        if not env.get("HIVE_CHROMADB_LIB") and (chroma / "lib_chromadb.metta").exists():
            env["HIVE_CHROMADB_LIB"] = str(chroma)
        env.setdefault("HIVE_TEST_PETTA", env["PETTA_PATH"])
        if env.get("HIVE_CHROMADB_LIB"):
            env.setdefault("HIVE_TEST_CHROMADB_LIB", env["HIVE_CHROMADB_LIB"])
        for key in ("HIVE_DATA_DIR", "HIVE_PORT", "HIVE_ADMIN_PASSWORD", "HIVE_PUBLIC_URL"):
            env.pop(key, None)  # a run's own hives must never reuse this one's
        return env

    def _execute(self, run_id, suite_id):
        started = time.perf_counter()
        log, status = [], "error"
        try:
            proc = subprocess.Popen([sys.executable, "-m", "hive.bench", "run", suite_id], cwd=ROOT, env=self._env(),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            self.procs[run_id] = proc
            for line in proc.stdout:
                event = parse(line)
                if event is None:
                    log = (log + [line.rstrip()])[-300:]
                elif event["type"] == "case":
                    self._record_case(run_id, event)
                elif event["type"] == "log":
                    self.hive.events.publish("lab.log", run_id=run_id, text=event.get("text", ""))
                elif event["type"] == "end":
                    status = event.get("status", "error")
            code = proc.wait()
            if code < 0:
                status = "cancelled"
            elif status == "error" and code == 0:
                status = "passed"
        except Exception as exc:  # the run fails, the hive keeps going
            log.append(f"lab error: {exc!r}")
        finally:
            self.procs.pop(run_id, None)
            counts = self.db.one("SELECT passed, failed, errors FROM lab_runs WHERE id = ?", (run_id,))
            if status == "passed" and (counts["failed"] or counts["errors"]):
                status = "failed"
            self.db.update("lab_runs", run_id, {"status": status, "finished_at": now(), "log": "\n".join(log),
                                                "duration_ms": round((time.perf_counter() - started) * 1000, 1)})
            self._emit_run(run_id)

    def _record_case(self, run_id, event):
        status = event.get("status", "error")
        row = {"run_id": run_id, "case_id": str(event.get("id", "")), "name": str(event.get("name", ""))[:500],
               "grp": str(event.get("group", "")), "dimension": str(event.get("dimension") or "correctness"),
               "status": status, "duration_ms": event.get("duration_ms"),
               "message": event.get("message"), "notes": event.get("notes"),
               "metrics": json.dumps(event.get("metrics") or []), "series": json.dumps(event.get("series") or []),
               "created_at": now()}
        row_id = self.db.insert("lab_cases", row)
        column = COUNT.get(status, "errors")
        self.db.execute(f"UPDATE lab_runs SET {column} = {column} + 1 WHERE id = ?", (run_id,))
        stored = self.db.one("SELECT * FROM lab_cases WHERE id = ?", (row_id,))
        self.hive.events.publish("lab.case", case=self.case_view(stored))
        self._emit_run(run_id)
