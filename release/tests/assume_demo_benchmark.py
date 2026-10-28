#!/usr/bin/env python3
"""Small local benchmark for the public SmartHabitat Assume/Fabric demo.

This is intentionally not a unit test. It gives reviewers a quick feel for the
cost of the full symbolic-neural round trip on the current machine.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "modules" / "assume" / "src"
DEMO = ROOT / "demos" / "assume" / "SmartHabitatDemoSpace.metta"
FABRIC_REPO = pathlib.Path(os.environ.get("FABRICPC_REPO", str(ROOT.parent / "FabricPC")))
FABRIC_PYTHON = pathlib.Path(
    os.environ.get("FABRICPC_PYTHON", str(FABRIC_REPO / ".venv" / "bin" / "python"))
)

sys.path.insert(0, str(SRC))

import assume_client  # noqa: E402


def timed(label, fn):
    started = time.perf_counter()
    result = fn()
    elapsed_ms = (time.perf_counter() - started) * 1000
    return label, elapsed_ms, result


def main() -> int:
    if not FABRIC_PYTHON.exists():
        print(f"SKIP FabricPC python not found: {FABRIC_PYTHON}")
        return 77

    atoms = DEMO.read_text(encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(SRC), str(FABRIC_REPO)])
    proc = subprocess.Popen(
        [str(FABRIC_PYTHON), "-u", str(SRC / "assume_fabricd.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    def call(payload):
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())

    def show(label, elapsed_ms, result):
        status = "ok" if result.get("ok", True) else "error"
        print(f"{label:18s} {elapsed_ms:8.2f} ms {status}")
        return result

    try:
        ready = json.loads(proc.stdout.readline())
        if not ready.get("ready"):
            print(f"ERROR daemon not ready: {ready}")
            return 1

        load = show(*timed("load", lambda: call({
            "cmd": "load",
            "id": "bench::movie",
            "domain": "smart-habitat",
            "situation": "movie-evening",
            "atoms": atoms,
        })))
        predict = show(*timed("predict", lambda: call({
            "cmd": "predict",
            "id": "bench::movie",
            "atoms": atoms,
        })))
        audit = show(*timed("audit", lambda: call({
            "cmd": "audit",
            "id": "bench::movie",
            "action": "open-blinds",
            "atoms": atoms,
        })))
        learn = show(*timed("learn", lambda: call({
            "cmd": "learn",
            "id": "bench::movie",
            "atoms": atoms,
            "targets": {
                "dim-cinema-scene": 0.2,
                "welcome-guest-mode": 0.05,
                "ask-before-action": 0.85,
                "hold-silence": 0.7,
                "open-blinds": 0.05,
            },
        })))
        writeback = show(*timed("writeback", lambda: call({
            "cmd": "writeback",
            "id": "bench::movie",
        })))

        with tempfile.NamedTemporaryFile("w+", suffix=".metta", encoding="utf-8") as handle:
            handle.write(atoms)
            handle.flush()
            persist_started = time.perf_counter()
            persisted = assume_client.persist_writeback_delta(
                "smart-habitat",
                "movie-evening",
                writeback["atoms"],
                path=handle.name,
            )
            persist_ms = (time.perf_counter() - persist_started) * 1000
            handle.seek(0)
            committed_atoms = handle.read()
        print(f"{'persist-delta':18s} {persist_ms:8.2f} ms {persisted.split()[0]}")

        reload_result = show(*timed("reload", lambda: call({
            "cmd": "load",
            "id": "bench::movie",
            "domain": "smart-habitat",
            "situation": "movie-evening",
            "atoms": committed_atoms,
        })))

        print(
            "SUMMARY "
            f"features={load.get('features')} actions={load.get('actions')} edges={load.get('edges')} "
            f"prediction={predict.get('action')} confidence={predict.get('confidence'):.4f} "
            f"audit_verdict={'error-pressure' if 'error-pressure' in audit.get('report_atoms', '') else 'other'} "
            f"learn_targets={learn.get('target_count')} changed_edges={writeback.get('changed_edges')} "
            f"reload_edges={reload_result.get('edges')}"
        )
        return 0
    finally:
        if proc.poll() is None:
            try:
                call({"cmd": "stop"})
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
                proc.wait(timeout=10)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream and not stream.closed:
                stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
