"""Run a Lab suite:  python -m hive.bench run <suite>   |   python -m hive.bench list

``run`` speaks the line protocol in protocol.py on stdout; the hive's Lab
service runs it as a child process.  ``record`` runs suites and writes their
results to a JSON file (used to give the UI's demo mode real numbers).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

from .catalog import BY_ID, SUITES
from .protocol import emit, parse

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _run_pytest(suite):
    env = dict(os.environ, **suite.get("env", {}))
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(ROOT), env.get("PYTHONPATH")]))
    cmd = [sys.executable, "-m", "pytest", "-q", "-p", "hive.bench.pytest_stream", "-p", "no:cacheprovider",
           *suite["pytest"]]
    return _pipe(cmd, ROOT, env)


def _run_vitest():
    ui = ROOT / "hive" / "ui"
    if not (ui / "node_modules").exists():
        emit("case", id="tests-ui::setup", name="install", group="ui", status="skipped", duration_ms=0,
             message="run npm install in hive/ui first")
        return "skipped"
    out = ui / "node_modules" / ".lab-vitest.json"
    start = time.perf_counter()
    proc = subprocess.run(["npx", "vitest", "run", "--reporter=json", f"--outputFile={out}"], cwd=ui,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        report = json.loads(out.read_text())
    except (OSError, ValueError):
        emit("case", id="tests-ui::run", name="vitest", group="ui", status="error",
             duration_ms=round((time.perf_counter() - start) * 1000), message=proc.stdout[-6000:])
        return "error"
    worst = "passed"
    for file in report.get("testResults", []):
        group = pathlib.Path(file["name"]).name.split(".")[0]
        for test in file.get("assertionResults", []):
            status = {"passed": "passed", "failed": "failed"}.get(test["status"], "skipped")
            worst = "failed" if status == "failed" else worst
            emit("case", id=f"{group}::{test['fullName']}", name=test["fullName"], group=group,
                 dimension="correctness", status=status,
                 duration_ms=round(test.get("duration") or 0, 1),
                 message="\n".join(test.get("failureMessages") or [])[-6000:] or None)
    return worst


def _pipe(cmd, cwd, env):
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            bufsize=1)
    worst, tail = "passed", []
    for line in proc.stdout:
        event = parse(line)
        if event is None:
            tail = (tail + [line.rstrip()])[-40:]
            continue
        if event.get("status") in ("failed", "error"):
            worst = "failed"
        sys.stdout.write(line[line.find("@@bench "):])
        sys.stdout.flush()
    code = proc.wait()
    if code not in (0, 1, 5) or (code == 1 and worst == "passed"):
        emit("case", id="runner::exit", name="test runner", group="runner", status="error", duration_ms=0,
             message="\n".join(tail))
        return "error"
    return worst


def run(suite_id):
    suite = BY_ID[suite_id]
    if suite_id == "bench-omega-development":
        from omegabench.lab import run as run_development
        return run_development(emit)
    if suite_id == "tests-ui":
        return _run_vitest()
    if suite["kind"] == "tests":
        return _run_pytest(suite)
    if suite_id == "bench-swarm":
        from . import swarm
        return swarm.run()
    if suite_id == "bench-ops":
        from . import ops
        return ops.run()
    if suite_id == "bench-epistemic":
        from . import epistemic
        return epistemic.run()
    from .benchmarks import REGISTRY, run_case
    worst = "passed"
    for entry in REGISTRY[suite_id]:
        emit("log", text=f"running {entry['name']}")
        case = run_case(entry)
        emit("case", **case)
        if case["status"] in ("failed", "error"):
            worst = "failed"
    return worst


def record(suite_ids, out):
    """Run suites in child processes and store the results as Lab runs."""
    runs = []
    for suite_id in suite_ids:
        started = time.time()
        proc = subprocess.run([sys.executable, "-m", "hive.bench", "run", suite_id], cwd=ROOT,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        cases = [e for e in map(parse, proc.stdout.splitlines()) if e and e.get("type") == "case"]
        end = next((e for e in map(parse, reversed(proc.stdout.splitlines())) if e and e.get("type") == "end"), {})
        runs.append({"suite": suite_id, "status": end.get("status", "error"), "started": started,
                     "finished": time.time(), "cases": cases})
        print(f"{suite_id}: {end.get('status')} ({len(cases)} cases)", file=sys.stderr)
    pathlib.Path(out).write_text(json.dumps({"runs": runs}, indent=1))


def main():
    ap = argparse.ArgumentParser(prog="python -m hive.bench")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    one = sub.add_parser("run")
    one.add_argument("suite", choices=sorted(BY_ID))
    rec = sub.add_parser("record")
    rec.add_argument("--out", required=True)
    rec.add_argument("suites", nargs="*", default=[s["id"] for s in SUITES])
    args = ap.parse_args()
    if args.cmd == "list":
        for suite in SUITES:
            print(f"{suite['id']:16} {suite['kind']:6} {suite['title']}")
    elif args.cmd == "run":
        status = run(args.suite)
        emit("end", status=status)
    else:
        record(args.suites, args.out)


if __name__ == "__main__":
    main()
