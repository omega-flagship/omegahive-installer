"""Purpose: an Iter mind's MeTTa, run free in the sandbox for thinking in code.

Iter's own tools/metta.py runs any MeTTa through PeTTa in the worker, and PeTTa reaches every Prolog predicate and
Python, so that MeTTa could write a new tools/*.py the worker's loop then loads. Jon on omega-flagship/omegahive#395:
"Thinking in code is allowed by default (calculations, analysis, the mind's own MeTTa), as a sandboxed tool", with the
wall enforced "by what actually runs the code, not by file name". So a worker whose mind's own coding is off, the
default, gets this tool in its place (hive/supervisor/workspace.py): the same MeTTa with the NAL and PLN libraries,
and the metta/ files a MeTTa-loop worker keeps, run through _think_sandbox.py, which lets it write only a scratch
folder that goes when the run ends and reach no network. macOS refuses that sandbox inside the mind's own, so there
PeTTa runs as a swipl of its own (HIVE_THINK_SWIPL), which the mind's profile gives the same limits. Where neither can
be had, the hive's gate decides each use, as it does for the kit's shell. A mind whose owner switched its own coding
on gets Iter's own metta.py back.
"""

import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

_root = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("_hive", _root / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

SANDBOX = Path(__file__).resolve().with_name("_think_sandbox.py")
UNAVAILABLE, MARK = 75, "THINK-SANDBOX-UNAVAILABLE"   # _think_sandbox.py ran nothing
# On macOS, which refuses _think_sandbox.py's sandbox inside the mind's own, the swipl this tool's PeTTa runs as, which
# the mind's profile limits as that sandbox would (hive/supervisor/drivers.py LocalDriver._think, sandbox.profile)
THINK_SWIPL = os.environ.get("HIVE_THINK_SWIPL")
PETTA_DIR = Path.home() / "PeTTa"         # the worker's PeTTa, beside lib_nal and lib_pln (Workspace._iter_home)
RUN_SH = PETTA_DIR / "run.sh"
METTA_DIR = _root / "metta"               # a MeTTa-loop worker's knowledge, each file a space of its own name
SECONDS = 30                              # Iter's own metta.py limit
# The mind's token and every other secret stay out of the MeTTa run (the names hive/supervisor/sandbox.py drops)
SECRETISH = ("SECRET", "TOKEN", "KEY", "PASSWORD", "PASS", "CREDENTIAL", "COOKIE")

DEFAULT_IMPORTS = """!(import! &self lib_nal)
!(import! &self lib_pln)
"""

DESCRIPTION = ("Evaluate MeTTa code using PeTTa, with the NAL and PLN libraries loaded. Pass multi-line MeTTa code as "
               "a string. It runs sandboxed: it can reason and compute, but not change files, and it stops after 30 "
               "seconds. To build software, use hive_create instead.")


def run(code):
    """code: str - multi-line MeTTa code to evaluate; returns: str - what PeTTa printed"""
    code = str(code).strip()
    if not code:
        return "No MeTTa code provided"
    # the code file beside lib_nal and lib_pln, so PeTTa resolves their imports as Iter's own tool has it
    handle, path = tempfile.mkstemp(prefix="tmp_metta_", suffix=".metta", dir=PETTA_DIR)
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        file.write(_imports() + code)
    # on macOS the folder the mind's profile lets this PeTTa write; elsewhere TMPDIR, the worker's tmp/
    scratch = tempfile.mkdtemp(prefix="think-", dir=os.environ.get("HIVE_THINK_SCRATCH"))
    run_sh = ["bash", str(RUN_SH), path, "-s"]
    try:
        if THINK_SWIPL:
            # run.sh's own swipl command, with the swipl the mind's profile limits in place of PATH's
            status, out, err = _petta([THINK_SWIPL, "--stack_limit=8g", "-q", "-s", str(PETTA_DIR / "src" / "main.pl"),
                                       "--", path, "-s"], scratch)
        else:
            status, out, err = _petta([sys.executable, "-I", "-B", str(SANDBOX), scratch, "--", *run_sh], scratch)
            if status == UNAVAILABLE and err.startswith(MARK):
                refused = _asked(code)
                if refused:
                    return refused
                status, out, err = _petta(run_sh, scratch)
        if status is None:
            return f"Timeout: MeTTa evaluation took longer than {SECONDS} seconds"
        output = out + ("\n[STDERR]\n" + err if err else "")
        return output if output.strip() else "(no output)"
    finally:
        os.unlink(path)
        shutil.rmtree(scratch, ignore_errors=True)


def _imports():
    imports = DEFAULT_IMPORTS
    if METTA_DIR.is_dir():
        for file in sorted(METTA_DIR.glob("*.metta")):
            imports += f'!(import! &{file.stem} "{file}")\n'
    return imports


def _petta(argv, scratch):
    """(exit status, stdout, stderr) of one PeTTa run, its exit status None when it timed out and its whole process
    group was ended."""
    env = {name: value for name, value in os.environ.items() if not any(s in name.upper() for s in SECRETISH)}
    env.update(TMPDIR=scratch, PYTHONDONTWRITEBYTECODE="1")
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", env=env,
                               start_new_session=True)
    try:
        out, err = process.communicate(timeout=SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)   # its whole group, so no child outlives the use
        process.communicate()
        return None, "", ""
    return process.returncode, out, err


def _asked(code):
    """Where the sandbox can't be built: the hive's gate decides this MeTTa as it decides an Omega mind's. None when
    it allows the run, else what to tell the mind."""
    command = "(metta " + json.dumps(code, ensure_ascii=False) + ")"
    result, error = _hive.call("POST", "/api/agent/authorize", {"command": command})
    if error:
        return f"HIVE-GATE-UNAVAILABLE {error}; the MeTTa was not run"
    if result.get("decision") != "allow":
        return result.get("message") or f"HIVE-DENIED {command}"
    return None
