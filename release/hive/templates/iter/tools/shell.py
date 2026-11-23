"""Purpose: an Iter mind's shell for thinking in code, asked of the hive's gate each time it runs.

Iter's own tools/shell.py and tools/python.py run whatever a mind writes inside the worker and never ask the hive.
Jon's line on omega-flagship/omegahive#395 keeps thinking in code (a quick calculation, a look at data, ls) as a
sandboxed tool that asks per use, and leaves building software to Create. So a worker whose mind's own coding is off,
the default, gets this tool in their place (hive/supervisor/workspace.py): the hive's gate decides the command as it
decides an Omega mind's shell, and it then runs as that shell does, sh -c with its process group ended after 5 seconds.
A mind whose owner switched its own coding on gets Iter's own two tools back instead.
"""

import importlib.util
import json
import os
import signal
import subprocess
from pathlib import Path

_kit = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("_hive", _kit / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

# The Omega shell's limit (third_party/Omega/src/skills.pl runs timeout -k 1s 5s sh -c)
SECONDS = 5

DESCRIPTION = ("Run one shell command to think in code: a quick calculation, a look at data, ls. A person approves "
               "each use, and it stops after 5 seconds. To build software, use hive_create instead.")


def run(cmd):
    cmd = str(cmd)
    # the same command text every time, so a person's approval of it lets exactly this command run once
    command = "(shell " + json.dumps(cmd, ensure_ascii=False) + ")"
    result, error = _hive.call("POST", "/api/agent/authorize", {"command": command})
    if error:
        return f"HIVE-GATE-UNAVAILABLE {error}; the command was not run"
    if result.get("decision") != "allow":
        return result.get("message") or f"HIVE-DENIED {command}"
    process = subprocess.Popen(["sh", "-c", cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               errors="replace", start_new_session=True)
    try:
        output, _ = process.communicate(timeout=SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)   # its whole group, as timeout -k does, so no child outlives the use
        process.communicate()
        return "timeout_error"
    return "SUCCESS, RETURN: " + output
