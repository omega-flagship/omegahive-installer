"""The theme's rules on the host: the same theme.rules.json the browser reads (hive/ui/src/theme, made from theme.metta by
PeTTa), so a look the host stores is held to exactly what the browser applies. One source; this module only measures
(WCAG 2.2 contrast) and tries the allowed repair (OKLCH lightness), as hive/ui/src/theme/themeCheck.ts does.

Pure. ``check_look(colors)`` returns the failures that remain after the allowed repair: [] means the look can be worn.
"""
from __future__ import annotations

import json
import math
import pathlib
import re

RULES_PATH = pathlib.Path(__file__).resolve().parents[1] / "ui" / "src" / "theme" / "theme.rules.json"
RULES = json.loads(RULES_PATH.read_text())
CHECKS = RULES["checks"]
GIVE_UP = float(RULES["giveUpAfter"])
REPAIR = "lightness-nearest"
# the tokens the rules read against each other: these must be solid #rrggbb, or a see-through one would skip a check
READ_TOKENS = frozenset(t for c in CHECKS for t in (c["token"], c["against"]))
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def _rgb(h):
    return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _unlin(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def contrast(a, b):
    """WCAG 2.2 contrast ratio between two #rrggbb colours."""
    def lum(h):
        r, g, bb = (_lin(c) for c in _rgb(h))
        return 0.2126 * r + 0.7152 * g + 0.0722 * bb
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def to_oklch(h):
    r, g, b = (_lin(c) for c in _rgb(h))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    return L, math.hypot(A, B), math.atan2(B, A)


def from_oklch(L, C, h):
    A, B = C * math.cos(h), C * math.sin(h)
    l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    rgb = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    # rounds half up, as Math.round does in the browser, so both sides repair to the same colour
    return "#" + "".join(f"{math.floor(min(1, max(0, _unlin(max(0.0, c)))) * 255 + 0.5):02x}" for c in rgb)


def check_look(colors):
    """Failures [{token, against, ratio, floor}] left after the rules' repair; [] when the look can be worn.

    Fails closed: a colour the rules read that is missing, null or not solid #rrggbb is a failure (ratio None), never a
    check skipped. The decision is on the exact ratio; ``ratio`` is rounded down to two places, for the message only.
    """
    colors = dict(colors)

    def solid(k):
        return isinstance(colors.get(k), str) and HEX.fullmatch(colors[k]) is not None

    def failing():
        return [c for c in CHECKS
                if not (solid(c["token"]) and solid(c["against"]))
                or contrast(colors[c["token"]], colors[c["against"]]) < c["floor"]]

    for token in dict.fromkeys(c["token"] for c in failing()):
        mine = [c for c in CHECKS if c["token"] == token and c["repair"] == REPAIR]
        if not mine or not all(solid(k) for c in mine for k in (c["token"], c["against"])):
            continue
        L0, C, h = to_oklch(colors[token])
        # the smallest lightness change that reads: away from the surfaces first, then toward them
        away = 1 if sum(to_oklch(colors[c["against"]])[0] for c in mine) / len(mine) < 0.5 else -1
        found = None
        for step in range(1, int(round(GIVE_UP * 100)) + 1):
            for d in (away, -away):
                L = L0 + d * step / 100
                if 0 <= L <= 1:
                    nxt = from_oklch(L, C, h)
                    if all(contrast(nxt, colors[c["against"]]) >= c["floor"] for c in mine):
                        found = nxt
                        break
            if found:
                break
        if found:
            colors[token] = found
    def shown(c):  # rounded down, so a ratio below the floor never reads as the floor
        if not (solid(c["token"]) and solid(c["against"])):
            return None
        return math.floor(contrast(colors[c["token"]], colors[c["against"]]) * 100) / 100

    return [{"token": c["token"], "against": c["against"], "floor": c["floor"], "ratio": shown(c)} for c in failing()]
