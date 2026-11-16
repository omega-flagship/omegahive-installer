#!/usr/bin/env python3
"""Print a reviewer-readable SmartHabitat Assume/Fabric story.

This is not a unit test. It is a compact demonstration trace for reviewers who
want to see the symbolic-neural loop in action:

1. load sanitized MeTTa atoms;
2. predict and audit;
3. learn from explicit targets;
4. inspect symbolic writeback;
5. reload the committed graph and show changed prediction scores.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "modules" / "assume" / "src"
DEMO = ROOT / "demos" / "assume" / "SmartHabitatDemoSpace.metta"
FABRIC_REPO = pathlib.Path(os.environ.get("FABRICPC_REPO", str(ROOT.parent / "FabricPC")))
FABRIC_PYTHON = pathlib.Path(
    os.environ.get("FABRICPC_PYTHON", str(FABRIC_REPO / ".venv" / "bin" / "python"))
)

sys.path.insert(0, str(SRC))

import assume_client  # noqa: E402


def _verdict(text: str) -> str:
    match = re.search(r"\(Verdict ([^()\s]+)\)", text)
    return match.group(1) if match else "missing"


def _reason(text: str) -> str:
    match = re.search(r"\(Reason ([^()\s]+)\)", text)
    return match.group(1) if match else "missing"


def _top(scores: dict[str, float], count: int = 5) -> dict[str, float]:
    return {
        key: round(value, 4)
        for key, value in sorted(scores.items(), key=lambda item: -item[1])[:count]
    }


def _first_atom(atoms: str, atom_name: str) -> str:
    prefix = f"({atom_name} "
    start = atoms.find(prefix)
    if start < 0:
        return f"({atom_name} missing)"
    depth = 0
    for index in range(start, len(atoms)):
        char = atoms[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return atoms[start:index + 1]
    return f"({atom_name} missing)"


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

    try:
        ready = json.loads(proc.stdout.readline())
        print("READY", ready)

        load = call({
            "cmd": "load",
            "id": "demo::movie",
            "domain": "smart-habitat",
            "situation": "movie-evening",
            "atoms": atoms,
        })
        print("LOAD", {name: load.get(name) for name in ("ok", "features", "actions", "edges", "feedback")})
        if not load.get("ok"):
            print("LOAD_ERROR", load.get("error"))
            return 1

        before = call({"cmd": "predict", "id": "demo::movie", "atoms": atoms})
        print(
            "PREDICT_BEFORE",
            before["action"],
            "score",
            round(before["score"], 4),
            "confidence",
            round(before.get("confidence", 0), 4),
        )
        print("BEFORE_SCORES", _top(before["scores"]))

        audit_good = call({
            "cmd": "audit",
            "id": "demo::movie",
            "action": "dim-cinema-scene",
            "atoms": atoms,
        })
        audit_bad = call({
            "cmd": "audit",
            "id": "demo::movie",
            "action": "open-blinds",
            "atoms": atoms,
        })
        print("AUDIT_DIM", _verdict(audit_good["report_atoms"]), _reason(audit_good["report_atoms"]))
        print("AUDIT_OPEN_BLINDS", _verdict(audit_bad["report_atoms"]), _reason(audit_bad["report_atoms"]))

        targets = {
            "dim-cinema-scene": 0.2,
            "welcome-guest-mode": 0.05,
            "ask-before-action": 0.85,
            "hold-silence": 0.7,
            "open-blinds": 0.05,
        }
        learned = call({
            "cmd": "learn",
            "id": "demo::movie",
            "atoms": atoms,
            "targets": targets,
        })
        print("LEARN", {name: learned.get(name) for name in ("ok", "dirty", "target_count")}, "targets", targets)

        writeback = call({"cmd": "writeback", "id": "demo::movie"})
        updated_edges = writeback.get("changed_edges", writeback["atoms"].count("AssumeUpdatedFeatureEdge"))
        print("WRITEBACK", {name: writeback.get(name) for name in ("ok", "dirty")}, "updated_edges", updated_edges)
        print("WRITEBACK_EDGE_SAMPLE", _first_atom(writeback["atoms"], "AssumeUpdatedFeatureEdge"))
        print("MUTATION_TRACE_SAMPLE", _first_atom(writeback["atoms"], "AssumeWeightMutation"))
        print("MUTATION_PRIMITIVE_SAMPLE", _first_atom(writeback["atoms"], "AssumeWeightDelta"))
        print("MUTATION_TRUTH_SAMPLE", _first_atom(writeback["atoms"], "AssumeMutationTruth"))
        print("FABRIC_MUTATION_VERDICT_SAMPLE", _first_atom(writeback["atoms"], "AssumeFabricMutationVerdict"))

        with tempfile.NamedTemporaryFile("w+", suffix=".metta", encoding="utf-8") as handle:
            handle.write(atoms)
            handle.flush()
            persisted = assume_client.persist_writeback_delta(
                "smart-habitat",
                "movie-evening",
                writeback["atoms"],
                path=handle.name,
            )
            handle.seek(0)
            committed = handle.read()
        print("PERSIST", persisted)

        reload = call({
            "cmd": "load",
            "id": "demo::movie",
            "domain": "smart-habitat",
            "situation": "movie-evening",
            "atoms": committed,
        })
        after = call({"cmd": "predict", "id": "demo::movie", "atoms": committed})
        print("RELOAD", {name: reload.get(name) for name in ("ok", "features", "actions", "edges", "feedback")})
        print(
            "PREDICT_AFTER",
            after["action"],
            "score",
            round(after["score"], 4),
            "confidence",
            round(after.get("confidence", 0), 4),
        )
        print("AFTER_SCORES", _top(after["scores"]))
        print("DELTA dim-cinema-scene", round(after["scores"]["dim-cinema-scene"] - before["scores"]["dim-cinema-scene"], 4))
        print("DELTA ask-before-action", round(after["scores"]["ask-before-action"] - before["scores"]["ask-before-action"], 4))
    finally:
        if proc.poll() is None:
            try:
                call({"cmd": "stop"})
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
                proc.wait(timeout=10)
        stderr = proc.stderr.read() if proc.stderr else ""
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream and not stream.closed:
                stream.close()
        if stderr.strip():
            print("STDERR", stderr[-1000:])
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
