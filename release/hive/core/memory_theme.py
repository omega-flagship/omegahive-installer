"""P8's release-bound, data-only palette schema; this module performs no inference.

``memory_theme`` has optional scalar tokens plus at most four named children.
A named child has the same scalar tokens and an optional ``dark`` token object.
``memory_theme_dark`` is a token-only override of the default light theme.
There are no recursive variants, CSS strings, URLs, assets or extension hooks.
"""
from __future__ import annotations

import math
import re

MEMORY_COLOR_SLOTS = ("surface", "panel", "text", "muted", "accent", "border", "positive", "danger")
MEMORY_FONT_IDS = ("system", "humanist", "serif", "mono")
MEMORY_MOTIONS = ("none", "gentle", "lively")
MEMORY_SCALAR_KEYS = frozenset((*MEMORY_COLOR_SLOTS, "radius", "font", "motion"))
_NAME = re.compile(r"[a-z0-9-]{1,24}\Z")
_HEX = re.compile(r"#[0-9a-fA-F]{6}\Z")
_RESERVED = MEMORY_SCALAR_KEYS | {"dark", "constructor", "prototype"}
_DEFAULT_COLORS = {"surface": "#ffffff", "panel": "#f3f4f7", "text": "#0b0820", "muted": "#484256",
                   "accent": "#5741d9", "border": "#bcb7cc", "positive": "#17653c", "danger": "#9e2038"}


def _tokens(value):
    if type(value) is not dict or any(type(key) is not str or key not in MEMORY_SCALAR_KEYS for key in value):
        raise ValueError("memory theme tokens must be a closed scalar object")
    out = {}
    for key, token in value.items():
        if key in MEMORY_COLOR_SLOTS:
            if not isinstance(token, str) or _HEX.fullmatch(token) is None:
                raise ValueError("memory theme colors must be #rrggbb")
            out[key] = token.lower()
        elif key == "radius":
            if type(token) not in (int, float) or not 0 <= token <= 32 or not math.isfinite(token):
                raise ValueError("memory theme radius must be finite pixels from 0 to 32")
            out[key] = token
        elif key == "font":
            if type(token) is not str or token not in MEMORY_FONT_IDS:
                raise ValueError("memory theme font must be a host-owned identifier")
            out[key] = token
        elif key == "motion":
            if type(token) is not str or token not in MEMORY_MOTIONS:
                raise ValueError("memory theme motion must be none, gentle or lively")
            out[key] = token
    return out


def _luminance(color):
    values = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]


def memory_color_contrast(left, right):
    """WCAG display-color contrast, not a confidence or belief computation."""
    a, b = _luminance(left), _luminance(right)
    return (max(a, b) + .05) / (min(a, b) + .05)


def memory_palette(tokens):
    """The host's render plan, checked at load too; substitutions never change source bytes."""
    colors = dict(_DEFAULT_COLORS, **{key: tokens[key] for key in MEMORY_COLOR_SLOTS if key in tokens})
    candidates = ("#0b0820", "#ffffff", "#000000")

    def floor(ink):
        return min(memory_color_contrast(ink, colors["surface"]), memory_color_contrast(ink, colors["panel"]))

    # One foreground may be unable to contrast against two opposite backgrounds.
    # In that case use a common background before choosing the host's foreground.
    if max(map(floor, candidates)) < 4.5:
        colors["panel"] = colors["surface"]
    fallback = max(candidates, key=floor)
    for key in ("text", "muted", "positive", "danger"):
        if floor(colors[key]) < 4.5:
            colors[key] = fallback
    accent_ink = max(("#ffffff", "#0b0820"), key=lambda ink: memory_color_contrast(ink, colors["accent"]))
    if memory_color_contrast(accent_ink, colors["accent"]) < 4.5:
        colors["accent"] = _DEFAULT_COLORS["accent"]
        accent_ink = max(("#ffffff", "#0b0820"), key=lambda ink: memory_color_contrast(ink, colors["accent"]))
    return dict(colors, accent_text=accent_ink)


def parse_memory_themes(manifest):
    """Validate and copy only present theme fields, including every named and dark branch.

    Unknown scalar tokens and fonts are load errors. Render-time consumers still
    revalidate and fall back, so a later withdrawn identifier cannot break a view.
    """
    if type(manifest) is not dict:
        raise ValueError("memory theme manifest must be an object")
    result = {}
    base = {}
    variants = {}
    if "memory_theme" in manifest:
        theme = manifest["memory_theme"]
        if type(theme) is not dict or any(type(key) is not str for key in theme):
            raise ValueError("memory_theme must be a closed token and variant object")
        base = _tokens({key: value for key, value in theme.items() if key in MEMORY_SCALAR_KEYS})
        names = [key for key in theme if key not in MEMORY_SCALAR_KEYS]
        if len(names) > 4:
            raise ValueError("memory_theme permits at most four named variants")
        for name in names:
            if _NAME.fullmatch(name) is None or name in _RESERVED:
                raise ValueError("memory theme variant name must be a nonreserved identifier")
            value = theme[name]
            if type(value) is not dict:
                raise ValueError("named memory theme must be a token object")
            variant = _tokens({key: token for key, token in value.items() if key != "dark"})
            if "dark" in value:
                variant["dark"] = _tokens(value["dark"])
            variants[name] = variant
        result["memory_theme"] = dict(base, **variants)
    if "memory_theme_dark" in manifest:
        result["memory_theme_dark"] = _tokens(manifest["memory_theme_dark"])
    # Every renderable branch receives the same host contrast plan at load.
    branches = [base, dict(base, **result.get("memory_theme_dark", {}))]
    for variant in variants.values():
        light = dict(base, **{key: token for key, token in variant.items() if key != "dark"})
        branches.extend((light, dict(light, **variant.get("dark", {}))))
    for branch in branches:
        palette = memory_palette(branch)
        if any(memory_color_contrast(palette[key], palette[background]) < 4.5
               for key in ("text", "muted", "positive", "danger") for background in ("surface", "panel")):
            raise ValueError("host memory theme contrast fallback failed")
        if memory_color_contrast(palette["accent_text"], palette["accent"]) < 4.5:
            raise ValueError("host memory accent contrast fallback failed")
    return result
