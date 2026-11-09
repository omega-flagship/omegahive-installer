"""PeTTa side of the showreel's PLN maths check (Surface demo D4).

Runs every worked example in src/features/showreel/pln/cases.json on PeTTa, in process, the way the hive's own space
service does (hive/spaces/service.py: `from petta import PeTTa`), with the hive's own lib_nal.metta and lib_pln.metta
from the repository root (the files the minds run). The approach is scripts/mind-metta-parity.py's (Surface mind-metta
r1). Writes src/features/showreel/pln/petta-reference.json, which pln.test.ts compares with the numbers the page shows.

Then the sim commons' cases (Surface sim-commons r1, src/api/sim/parity/cases.json): lib_nal Truth_Revision pairs, and
per swarm the assertions in order through lib_hive's hive-publish!, the way hive/spaces/service.py sends them (a grant per
member, stamps "ev:a:n" as sorted (ev a n), truth values as float reprs). Statements are strings, as the sim holds them.
Writes src/api/sim/parity/petta-reference.json, which commons.parity.test.ts compares with MeTTaScript.

    PATH=<swipl bin>:$PATH PETTA_PATH=<your PeTTa checkout> \
      <your python 3.12> -I scripts/showreel-pln-reference.py
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

UI = pathlib.Path(__file__).resolve().parent.parent
REPO = UI.parent.parent
HERE = UI / "src/features/showreel/pln"
PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
sys.path.insert(0, str(pathlib.Path(PETTA) / "python"))
os.environ.setdefault("LANG", "C.UTF-8")
from petta import PeTTa  # noqa: E402

LIBS = ["lib_nal.metta", "lib_pln.metta"]
metta = PeTTa(verbose=False, petta_path=PETTA)
for lib in LIBS:
    metta.load_metta_file(str(REPO / lib))


def run(expr):
    try:
        return [str(r) for r in metta.process_metta_string(f"!{expr}")]
    except Exception as exc:  # an engine error is a result too
        return [f"(PeTTa-exception {type(exc).__name__})"]


STV = re.compile(r"^\(stv (\S+) (\S+)\)$")
cases = json.loads((HERE / "cases.json").read_text())["cases"]
results = {}
exprs = {}
for c in cases:
    parts = []
    for a in c["args"]:
        if isinstance(a, dict):  # an earlier case's conclusion, exactly as PeTTa printed it
            parts.append(results[a["from"]][0])
        elif isinstance(a, list):
            parts.append(f"(stv {a[0]} {a[1]})")
        else:
            parts.append(str(a))
    expr = f"({c['fn']} {' '.join(parts)})"
    exprs[c["id"]] = expr
    results[c["id"]] = run(expr)
    one = results[c["id"]]
    if len(one) != 1 or not (STV.match(one[0]) or re.match(r"^-?[0-9.eE+-]+$", one[0])):
        raise SystemExit(f"{c['id']}: unexpected result {one}")

out = {
    "note": "Written by scripts/showreel-pln-reference.py: each case of cases.json run on PeTTa with the repository's lib_nal.metta and lib_pln.metta. Do not edit by hand.",
    "engine": "PeTTa " + subprocess.run(["git", "-C", PETTA, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(),
    "swipl": subprocess.run(["swipl", "--version"], capture_output=True, text=True).stdout.strip(),
    "libs": {lib: hashlib.sha256((REPO / lib).read_bytes()).hexdigest() for lib in LIBS},
    "cases": {k: {"expr": exprs[k], "result": v[0]} for k, v in results.items()},
}
(HERE / "petta-reference.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"{len(results)} cases on {out['engine']} ({out['swipl']})")
for k, v in out["cases"].items():
    print(f"  {k}: {v['expr']} -> {v['result']}")


# ---- the sim commons (Surface sim-commons r1, r2) ---------------------------------------------------------------------
SIM = UI / "src/api/sim/parity"
HIVE_LIB = "hive/spaces/lib_hive.metta"
metta.load_metta_file(str(REPO / HIVE_LIB))
sys.path.insert(0, str(REPO / "hive"))
from spaces import sexpr  # noqa: E402  (the host's own statement grammar)

EV = re.compile(r"^ev:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}):(\d{1,12})$")


def stv(pair):
    return f"(stv {float(pair[0])!r} {float(pair[1])!r})"


def stamp_atoms(stamp):
    parts = []
    for item in stamp:
        m = EV.match(item)
        if not m:
            raise SystemExit(f"bad evidence id {item!r}")
        parts.append(f"(ev {sexpr.safe_symbol(m[1])} {int(m[2])})")
    return "(" + " ".join(sorted(parts)) + ")"


def stamp_json(text):
    return [f"ev:{a}:{n}" for a, n in re.findall(r"\(ev (\S+) (\d+)\)", text)]


sim_cases = json.loads((SIM / "cases.json").read_text())
revisions = []
for a, b in sim_cases["revisions"]:
    expr = f"(Truth_Revision {stv(a)} {stv(b)})"
    r = run(expr)
    if len(r) != 1 or not STV.match(r[0]):
        raise SystemExit(f"{expr}: unexpected {r}")
    revisions.append({"args": [a, b], "expr": expr, "result": r[0]})

commons = []
for ci, c in enumerate(sim_cases["commons"]):
    # as service.py: &commons_<swarm>, &vocab_<swarm>, one access list; grants only for the case's members
    space, vocab, acl = f"&commons_sim{ci}", f"&vocab_sim{ci}", f"&hive_acl_sim{ci}"
    for agent in c["members"]:
        run(f"(add-atom {acl} (Grant {sexpr.safe_symbol(agent)} {space} $stmt publish))")
    for term in c["vocab"]:
        run(f"(hive-vocab-add! {vocab} {sexpr.safe_symbol(term)} hive)")
    steps = []
    for st in c["steps"]:
        stmt = sexpr.safe_statement(st["statement"])
        answer = run(f"(hive-publish! {space} {vocab} {acl} {sexpr.safe_symbol(st['agent'])} {stmt} {stv(st['tv'])} {stamp_atoms(st['stamp'])})")
        if len(answer) != 1:
            raise SystemExit(f"{c['swarm']}: publish answered {answer}")
        result = sexpr.read_result(answer[0])
        outcome = result if isinstance(result, str) else result[0]
        unmapped = [str(x) for x in result[1]] if outcome == "quarantined" else None
        cur = run(f"(collapse (match {space} (Current {stmt} $t $s) ($t $s)))")
        m = re.match(r"^\(\((\(stv \S+ \S+\)) (\(.*\))\)\)$", cur[0]) if len(cur) == 1 else None
        if not m and cur != ["()"]:
            raise SystemExit(f"{c['swarm']}: Current answered {cur}")
        steps.append({"input": st, "outcome": outcome, "unmapped": unmapped, "result": answer[0], "tv": m[1] if m else None, "stamp": stamp_json(m[2]) if m else None})
    commons.append({"swarm": c["swarm"], "members": c["members"], "vocab": c["vocab"], "steps": steps})

sim_libs = ["lib_nal.metta", "lib_pln.metta", HIVE_LIB]
sim_out = {
    "note": "Written by scripts/showreel-pln-reference.py: src/api/sim/parity/cases.json run on PeTTa with the repository's lib_nal.metta, lib_pln.metta and hive/spaces/lib_hive.metta, statements through hive/spaces/sexpr.py. Do not edit by hand.",
    "engine": out["engine"],
    "swipl": out["swipl"],
    "libs": {lib: hashlib.sha256((REPO / lib).read_bytes()).hexdigest() for lib in sim_libs},
    "revisions": revisions,
    "commons": commons,
}
(SIM / "petta-reference.json").write_text(json.dumps(sim_out, indent=1, ensure_ascii=False) + "\n")
counts = {}
for c in commons:
    for st in c["steps"]:
        counts[st["outcome"]] = counts.get(st["outcome"], 0) + 1
print(f"sim commons: {len(revisions)} revisions, {sum(len(c['steps']) for c in commons)} commons steps on {out['engine']}: {counts}")
