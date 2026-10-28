"""Compatibility facade for the the agent VM module.

The cognitive contract and implementation live in ``modules/omega_vm``. This
shim preserves the simple ``py-call (omega_vm.*)`` import surface used by the
current MeTTa Python bridge.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.omega_vm.src.omega_vm import *  # noqa: F401,F403,E402
