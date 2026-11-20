# Purpose: decide whether what a module's manifest requires holds where this mind runs, so a module whose requirement
# is shown missing here stays out of the mind (helper_command_parser.module_selection).
"""What a ``requires`` entry of a module.toml means where a mind runs: met, missing or unknown.

An entry is ``name>=version``, ``name==version`` or ``kind:value``, the three forms the module contract test reads
(tests/test_module_organs.py expected_dependency_atom). One rule per form:

==========================  ==========================================================  =========================
entry                       met when                                                    cannot tell
==========================  ==========================================================  =========================
``python>=3.10``            this interpreter is at least that version                  never
``service:omegacode``       this mind has the client it reaches that service with      whether the service answers,
                            (SERVICES)                                                  and a service with no check
``name>=v``, ``name==v``    an installed Python distribution of that name is such a     an executable's version
                            version, or an executable of that name is on PATH
``kind:value``, any other   no rule                                                     always
==========================  ==========================================================  =========================

Unknown counts as met: a module is left out only when an entry is shown missing, never on a guess, so a service that
is not up yet when the mind loads, or a tool whose version would take running it, keeps its module in.
"""

import importlib.machinery
import importlib.metadata
import os
import pathlib
import re
import shutil
import sys
import tomllib

MET, MISSING, UNKNOWN = "met", "missing", "unknown"
_ENTRY = re.compile(r"^\s*([A-Za-z0-9_.@/+-]+?)\s*(>=|==|:)\s*(\S.*?)\s*$")


def _version(text):
    """(17, 2) for "17.2", (2, 1, 0) for "2.1.0rc1": each dot part's leading digits, up to the first part that is not
    all digits. () when the text starts with none."""
    parts = []
    for part in str(text).strip().split("."):
        digits = re.match(r"\d+", part)
        if not digits:
            break
        parts.append(int(digits.group()))
        if digits.end() != len(part):
            break
    return tuple(parts)


def _meets(have, op, want):
    """Whether version text ``have`` is ``op`` (>= or ==) ``want``, missing parts read as 0; None when either names no
    version at all."""
    have, want = _version(have), _version(want)
    if not have or not want:
        return None
    width = max(len(have), len(want))
    have, want = have + (0,) * (width - len(have)), want + (0,) * (width - len(want))
    return have >= want if op == ">=" else have == want


def _omegacode(environ):
    """The OmegaCode native client the code_workspace skills call: modules/code/src/omega_code.py _client imports
    omegacode.client from OMEGACODE_SRC or this interpreter's own path. Found without importing it, after dropping the
    import system's folder listings (importlib.invalidate_caches): a folder this Python listed before the client was
    written there keeps its old listing while its mtime reads unchanged, so a client installed since would read as
    missing, as this rule's own test did on CI on 20 Nov."""
    importlib.invalidate_caches()
    source = environ.get("OMEGACODE_SRC", "")
    package = importlib.machinery.PathFinder.find_spec("omegacode", ([source] if source else []) + sys.path)
    if package is not None and package.submodule_search_locations is not None:
        if importlib.machinery.PathFinder.find_spec("omegacode.client", list(package.submodule_search_locations)):
            return MET, "the OmegaCode client imports from " + (source or "this Python's path")
    where = f"OMEGACODE_SRC ({source}) holds none" if source else "OMEGACODE_SRC is unset"
    return MISSING, f"no OmegaCode client for this mind: {where} and this Python's path has none"


# The services a mind can be shown to reach or not at load, each by the client it would reach it with. A service with
# no entry here cannot be told, so it counts as met.
SERVICES = {"omegacode": _omegacode}


def _installed(name, op, want, environ):
    """A Python distribution or an executable named ``name``: met when the distribution is such a version or the
    executable is on PATH (its version would take running it, so it is not told)."""
    try:
        have = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        have = None
    if have is not None:
        meets = _meets(have, op, want)
        if meets:
            return MET, f"{name} {have} is installed"
        if meets is None:
            return UNKNOWN, f"{name} {have} is installed and {op}{want} cannot be compared with it"
    if shutil.which(name, path=environ.get("PATH")):
        return MET, f"{name} is on PATH"
    if have is not None:
        return MISSING, f"{name} {have} is installed, not {op}{want}"
    return MISSING, f"no Python distribution or executable named {name}"


def requirement_state(entry, environ=None):
    """(MET, MISSING or UNKNOWN, why) for one requires entry, by the table above."""
    environ = os.environ if environ is None else environ
    form = _ENTRY.match(str(entry))
    if form is None:
        return UNKNOWN, f"{entry!r} is not name>=version, name==version or kind:value"
    name, op, value = form.groups()
    if op == ":":
        probe = SERVICES.get(value) if name == "service" else None
        return probe(environ) if probe else (UNKNOWN, f"no check for {entry}")
    if name == "python":
        have = "{}.{}.{}".format(*sys.version_info[:3])
        meets = _meets(have, op, value)
        if meets is None:
            return UNKNOWN, f"python {op}{value} cannot be compared with {have}"
        return (MET, f"Python {have}") if meets else (MISSING, f"Python {have}, not {op}{value}")
    return _installed(name, op, value, environ)


def unmet(module_dir, environ=None):
    """[(entry, why)] for each requires entry of module_dir/module.toml shown missing here, in the manifest's order;
    [] when every entry is met or cannot be told, or when the directory has no manifest."""
    manifest = pathlib.Path(module_dir) / "module.toml"
    try:
        text = manifest.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    found = []
    for entry in tomllib.loads(text).get("requires", []):
        state, why = requirement_state(entry, environ)
        if state == MISSING:
            found.append((entry, why))
    return found
