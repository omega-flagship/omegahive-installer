"""Runtime guards for Python embedded inside SWI-Prolog Janus.

OmegaClaw uses Python as an execution membrane. When Python is embedded by
SWI-Prolog, ``sys.executable`` can point at ``swipl``. Libraries that spawn
Python helper processes, such as multiprocessing resource trackers used by ML
stacks, must be told the real Python executable explicitly.
"""

from __future__ import annotations

import multiprocessing
import os
import pathlib
import sys


def _candidate_python_executable() -> str | None:
    for name in ["OMEGACLAW_PYTHON_EXECUTABLE", "PYTHON_EXECUTABLE"]:
        value = os.environ.get(name)
        if value and pathlib.Path(value).is_file():
            return value

    virtual_env = os.environ.get("VIRTUAL_ENV")
    if virtual_env:
        candidate = pathlib.Path(virtual_env) / "bin" / "python"
        if candidate.is_file():
            return str(candidate)

    return None


def configure_embedded_python_runtime() -> str:
    """Return the Python executable configured for subprocess helpers.

    This is deliberately runtime plumbing, not cognition. It keeps Python
    libraries from accidentally re-entering SWI-Prolog when they need a Python
    child process.
    """

    executable = _candidate_python_executable()
    if not executable:
        return sys.executable

    try:
        multiprocessing.set_executable(executable)
    except Exception:
        pass

    sys.executable = executable
    return executable
