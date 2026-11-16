"""Compatibility facade for the VM policy organ."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.vm_policy.src.vm_policy import *  # noqa: F401,F403,E402
