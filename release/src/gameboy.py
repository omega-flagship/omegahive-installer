"""Compatibility facade for the Game Boy simulation module.

The cognitive contract and implementation live in ``modules/gameboy``. This
shim preserves the simple ``py-call (gameboy.*)`` import surface used by the
current MeTTa Python bridge.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.gameboy.src.gameboy import *  # noqa: F401,F403,E402
