"""PeTTa side of the mind-space parity check (Surface mind-metta r1).

Runs every case of src/lib/mindSpace/parity/cases.json and the step-by-step scenario.json on PeTTa, in process, the
way the hive's own space service does (hive/spaces/service.py: `from petta import PeTTa`), with the very .metta files
the browser runs (src/lib/mindSpace/metta). Writes src/lib/mindSpace/parity/petta.json, which parity.test.ts compares
with MeTTaScript.

    PATH=~/swipl-patched/bin:$PATH PETTA_PATH=~/OmegaDot/.runtime/PeTTa \
      ~/OmegaDot/.runtime/venv312/bin/python -I scripts/mind-metta-parity.py
"""
import json
import os
import pathlib
import subprocess
import sys

UI = pathlib.Path(__file__).resolve().parent.parent
HERE = UI / "src/lib/mindSpace"
PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "OmegaDot/.runtime/PeTTa"))
sys.path.insert(0, str(pathlib.Path(PETTA) / "python"))
os.environ.setdefault("LANG", "C.UTF-8")
from petta import PeTTa  # noqa: E402

metta = PeTTa(verbose=False, petta_path=PETTA)
for lib in ["lib_nal", "lib_pln", "lib_hive", "lib_mind"]:
    metta.load_metta_file(str(HERE / "metta" / f"{lib}.metta"))


def run(expr):
    try:
        return [str(r) for r in metta.process_metta_string(f"!{expr}")]
    except Exception as exc:  # an engine error is a result too
        return [f"(PeTTa-exception {type(exc).__name__})"]


cases = json.loads((HERE / "parity/cases.json").read_text())["cases"]
scenario = json.loads((HERE / "parity/scenario.json").read_text())["steps"]
out = {
    "engine": "PeTTa " + subprocess.run(["git", "-C", PETTA, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(),
    "swipl": subprocess.run(["swipl", "--version"], capture_output=True, text=True).stdout.strip(),
    "cases": {c["name"]: run(c["expr"]) for c in cases},
    "scenario": [run(s) for s in scenario],
}
out["mind"] = sorted(run("(match &mind $x $x)"))
out["history"] = sorted(run("(match &history $x $x)"))
(HERE / "parity/petta.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"{len(out['cases'])} cases, {len(out['scenario'])} scenario steps on {out['engine']} ({out['swipl']})")
