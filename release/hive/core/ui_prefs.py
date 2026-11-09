"""Per-person look and layout (Surface v1 seam): which UI variant someone uses, stored per principal.

A variant is data only: colour tokens, font stacks from an allow-listed alphabet, and a few enums (layout, density,
radius, motion). No CSS text, URLs or scripts are accepted, so a variant cannot fetch or exfiltrate anything. The
host owns legibility: a variant whose text or controls would be unreadable is refused, not repaired, because the
person chose it and should see why it was not applied.
"""

from __future__ import annotations

import json
import re

from .db import now
from . import theme_rules

SCHEMA = """
CREATE TABLE IF NOT EXISTS ui_prefs (
  principal TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_prefs_revision (
  principal TEXT PRIMARY KEY, rev INTEGER NOT NULL, epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_prefs_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
);
"""

VARIANT_SCHEMA = "omegasurface.variant/0.1"
LAYOUTS = ("rail", "topbar", "dock")
LANDINGS = ("awake", "pro")   # Ask-and-apps contract R1 §7: where this person lands in their look (absent = awake)
# Inside an app: each app's own declared theme, or the identity set designed by Surface (both host-rendered data).
APP_IDENTITIES = ("owner", "designed")
DENSITIES = ("compact", "regular", "roomy")
RADII = ("square", "soft", "round", "pill")
MOTIONS = ("none", "calm", "lively")
SCHEMES = ("dark", "light")
COLOR_KEYS = ("void", "abyss", "ink", "ink-2", "ink-3", "ink-4", "ink-5", "line", "line-2", "control", "glass",
              "glass-2", "accent", "primary-top", "primary-ink", "accent-2", "good", "warn", "bad")
# Translucent surfaces and dividers may carry alpha; everything read as text or edge must be solid #rrggbb. The list is the
# theme's rules (theme.metta via PeTTa → theme.rules.json), the same file the browser reads.
ALPHA_KEYS = tuple(theme_rules.RULES["translucent"])
FONT_KEYS = ("display", "sans", "mono")
VARIANT_KEYS = {"schema", "id", "name", "blurb", "scheme", "layout", "density", "radius", "motion", "fonts", "colors",
                "needs", "author"}
HEX = re.compile(r"#[0-9a-fA-F]{6}")
RGBA = re.compile(r"rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*/\s*(0|1|0?\.\d{1,3})\s*\)")
FONT = re.compile(r"[A-Za-z0-9 ,'\-]{1,200}")
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
MAX_BYTES = 8192
# A request body larger than this is refused before it is parsed.
MAX_BODY_BYTES = 16384


def has_family(stack):
    """A font stack must name at least one real family: a token with a letter, not just commas, quotes or spaces."""
    return any(re.search(r"[A-Za-z]", part.strip(" '")) for part in stack.split(","))



class UiPrefsError(Exception):
    def __init__(self, problems):
        super().__init__("; ".join(problems))
        self.problems = problems


def check_variant(v):
    """Problems with a variant manifest, or [] when the host can apply it as-is."""
    if not isinstance(v, dict):
        return ["variant must be an object"]
    p = []
    extra = set(v) - VARIANT_KEYS
    if extra:
        p.append(f"unknown keys: {', '.join(sorted(extra))}")
    if v.get("schema") != VARIANT_SCHEMA:
        p.append(f"schema must be {VARIANT_SCHEMA}")
    if not (isinstance(v.get("id"), str) and SLUG.fullmatch(v["id"])):
        p.append("id must be a lowercase slug")
    if not (isinstance(v.get("name"), str) and 0 < len(v["name"]) <= 40):
        p.append("name must be 1-40 characters")
    for key in ("blurb", "needs", "author"):
        if key in v and not (isinstance(v[key], str) and len(v[key]) <= 160):
            p.append(f"{key} must be text up to 160 characters")
    for key, allowed in (("scheme", SCHEMES), ("layout", LAYOUTS), ("density", DENSITIES), ("radius", RADII),
                         ("motion", MOTIONS)):
        if v.get(key) not in allowed:
            p.append(f"{key} must be one of {', '.join(allowed)}")
    fonts = v.get("fonts", {})
    if not isinstance(fonts, dict) or set(fonts) - set(FONT_KEYS):
        p.append("fonts may only set display, sans and mono")
    else:
        for key, value in fonts.items():
            if not (isinstance(value, str) and FONT.fullmatch(value) and has_family(value)):
                p.append(f"fonts.{key} must be a plain font stack (letters, digits, spaces, commas, quotes, hyphens)")
    colors = v.get("colors")
    if not isinstance(colors, dict):
        return p + ["colors must be an object"]
    missing = [k for k in COLOR_KEYS if k not in colors]
    if missing:
        p.append(f"colors missing: {', '.join(missing)}")
    if set(colors) - set(COLOR_KEYS):
        p.append(f"unknown colors: {', '.join(sorted(set(colors) - set(COLOR_KEYS)))}")
    solid_ok = True
    for key in COLOR_KEYS:
        value = colors.get(key)
        if key not in colors:
            continue                                        # reported once above, as "colors missing"
        if isinstance(value, str) and (HEX.fullmatch(value) or key in ALPHA_KEYS and RGBA.fullmatch(value)):
            continue
        p.append(f"colors.{key} must be #rrggbb" + (" or rgb(r g b / a)" if key in ALPHA_KEYS else ""))
        solid_ok = False
    if solid_ok and not missing:
        # the theme's rules, as the browser applies them: a shortfall the rules can repair is accepted (the browser wears
        # the repaired colour); what still falls short after the repair is refused with its reason
        for f in theme_rules.check_look(colors):
            if f["ratio"] is None:
                p.append(f"{f['token']} on {f['against']} can't be measured: both must be #rrggbb")
            else:
                p.append(f"{f['token']} on {f['against']} is {f['ratio']:.2f}:1, below {f['floor']:g}:1 even after repair")
    return p


def check_prefs(prefs):
    """Normalise a PUT body {variant: manifest|null, layout: enum|null, apps: owner|designed|null, experience: slug|null,
    landing: awake|pro|null}; raises UiPrefsError."""
    if not isinstance(prefs, dict) or set(prefs) - {"variant", "layout", "apps", "experience", "landing"}:
        raise UiPrefsError(["body may only set variant, layout, apps, experience and landing"])
    problems = []
    variant = prefs.get("variant")
    if variant is not None:
        problems += [f"variant: {x}" for x in check_variant(variant)]
    layout = prefs.get("layout")
    if layout is not None and layout not in LAYOUTS:
        problems.append(f"layout must be one of {', '.join(LAYOUTS)}")
    apps = prefs.get("apps")
    if apps is not None and apps not in APP_IDENTITIES:
        problems.append(f"apps must be one of {', '.join(APP_IDENTITIES)}")
    experience = prefs.get("experience")
    if experience is not None and not (isinstance(experience, str) and SLUG.fullmatch(experience)):
        problems.append("experience must be a lowercase slug (an experience the UI ships)")
    landing = prefs.get("landing")
    if landing is not None and landing not in LANDINGS:
        problems.append(f"landing must be one of {', '.join(LANDINGS)}")
    out = {"variant": variant, "layout": layout, "apps": apps, "experience": experience}
    if landing is not None:   # only stored when set, so every earlier stored shape is unchanged
        out["landing"] = landing
    if len(json.dumps(out)) > MAX_BYTES:
        problems.append(f"preferences exceed {MAX_BYTES} bytes")
    if problems:
        raise UiPrefsError(problems)
    return out


class StalePrefs(Exception):
    """A conditional write named a revision that is no longer current; nothing was written."""

    def __init__(self, current):
        super().__init__("look preferences changed since that revision")
        self.current = current


class UiPrefs:
    """One row per person, plus a revision kept in its own table. The revision only ever goes up, and it moves on by
    at least one every time this host starts (the epoch): a write prepared before a restart, whatever happened while
    the host was down (an older host without revisions may have rewritten or deleted looks during a rollback), is
    refused afterwards. Within one run, a reset clears the look but not the revision. So a write made against any
    earlier revision is refused, across timeouts, sign-out/sign-in (A->B->A) and a rollback-and-return."""

    def __init__(self, db):
        self.db = db
        with db._lock:
            db._conn.executescript(SCHEMA)
        with db.transaction():
            db.execute("INSERT INTO ui_prefs_epoch (id, epoch) VALUES (1, 1) "
                       "ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1")
            self.epoch = db.one("SELECT epoch FROM ui_prefs_epoch WHERE id = 1")["epoch"]

    def _read(self, principal):
        # One statement, so the look and its revision come from the same committed state.
        row = self.db.one(
            "SELECT (SELECT prefs FROM ui_prefs WHERE principal = ?1) AS prefs, "
            "(SELECT updated_at FROM ui_prefs WHERE principal = ?1) AS updated_at, "
            "(SELECT rev FROM ui_prefs_revision WHERE principal = ?1) AS rev, "
            "(SELECT epoch FROM ui_prefs_revision WHERE principal = ?1) AS epoch", (principal,))
        if row["rev"] is None:
            rev = self.epoch - 1             # never written by this host: 0 on its first run, more after each restart
        else:
            rev = row["rev"] + (self.epoch - row["epoch"])   # +1 for every start since this revision was written
        prefs = json.loads(row["prefs"]) if row["prefs"] is not None else None
        return {"prefs": prefs, "updated_at": row["updated_at"], "rev": rev}

    def get(self, principal):
        return self._read(principal)

    def _write(self, principal, value, base_rev):
        # Compare and set in one step under the connection lock: no other write can land between the check and the write.
        with self.db.transaction():
            current = self._read(principal)
            if base_rev is not None and base_rev != current["rev"]:
                raise StalePrefs(current)
            rev = current["rev"] + 1
            if value is None:
                self.db.execute("DELETE FROM ui_prefs WHERE principal = ?", (principal,))
                stamp = None
            else:
                stamp = now()
                self.db.execute(
                    "INSERT INTO ui_prefs (principal, prefs, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(principal) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
                    (principal, json.dumps(value), stamp))
            self.db.execute("INSERT INTO ui_prefs_revision (principal, rev, epoch) VALUES (?, ?, ?) "
                            "ON CONFLICT(principal) DO UPDATE SET rev = excluded.rev, epoch = excluded.epoch",
                            (principal, rev, self.epoch))
        return {"prefs": value, "updated_at": stamp, "rev": rev}

    def put(self, principal, prefs, base_rev=None):
        return self._write(principal, check_prefs(prefs), base_rev)

    def reset(self, principal, base_rev=None):
        return self._write(principal, None, base_rev)
