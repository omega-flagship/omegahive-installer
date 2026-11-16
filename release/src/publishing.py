"""Compatibility facade for the publishing module.

The real implementation lives in ``modules/publishing/src/publishing.py``.
This file preserves the historical ``py-call (publishing.*)`` and Python import
surface while the module tree becomes the canonical package boundary.
"""

from __future__ import annotations

import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.publishing.src.publishing import *  # noqa: F401,F403,E402
