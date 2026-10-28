"""Compatibility facade for the Home Assistant module.

The Home Assistant app now lives under ``modules/home_assistant`` so its skill
cards, signatures, runtime config, and trace policy travel as one module. This
facade preserves older internal imports such as ``import home`` used by the
generic observation router.
"""

from __future__ import annotations

import importlib.util
import pathlib


_ROOT = pathlib.Path(__file__).resolve().parents[1]
_BRIDGE = _ROOT / "modules" / "home_assistant" / "bridge" / "home_assistant.py"
_SPEC = importlib.util.spec_from_file_location("_omegaclaw_home_assistant_bridge", _BRIDGE)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Cannot load Home Assistant bridge from {_BRIDGE}")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


for _name, _value in vars(_MODULE).items():
    if _name.startswith("__"):
        continue
    globals()[_name] = _value

# Compatibility wrappers for tests/tools that patch the facade helpers directly.
def _area_entities(area_query):
    old_areas = getattr(_MODULE, "_areas", None)
    old_template = getattr(_MODULE, "_template", None)
    try:
        _MODULE._areas = globals().get("_areas", _MODULE._areas)
        _MODULE._template = globals().get("_template", _MODULE._template)
        return _MODULE._area_entities(area_query)
    finally:
        if old_areas is not None:
            _MODULE._areas = old_areas
        if old_template is not None:
            _MODULE._template = old_template
