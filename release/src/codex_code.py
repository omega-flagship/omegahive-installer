"""Compatibility facade for the Codex Code organ."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.codex_code.src.codex_code import *  # noqa: F401,F403,E402
