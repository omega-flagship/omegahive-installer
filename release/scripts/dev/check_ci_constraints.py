#!/usr/bin/env python3
"""Check that the Python packages installed in this interpreter are exactly the ones pinned in a constraints file.

Usage:
    python scripts/dev/check_ci_constraints.py PIN [--requirements REQUIREMENTS]

PIN is a pip constraints file of name==version lines (hive/ci-constraints.txt); comments and blank lines are skipped.
The check runs `python -m pip freeze --all --exclude pip --exclude setuptools --exclude wheel` with this interpreter
and fails when a package is installed with no line in PIN, installed at another version than its line, or has a line
in PIN but is not installed. With --requirements, it also fails when a name in that file has no line in PIN, a line
whose version is below the requirement's >= floor, or a line whose version is not the requirement's == pin. A
``-c FILE`` line in the requirements names a constraints file that pip applies at install, so it adds no name and is
skipped; any other option line, and any other operator, fails closed. On failure it prints what differs and the full
freeze, which is the regeneration output for PIN.

Names are compared the way pip does (lowercase, runs of "-", "_" and "." as one "-"). Standard library only.
"""

import argparse
import re
import subprocess
import sys

FREEZE_ARGS = ["-m", "pip", "freeze", "--all", "--exclude", "pip", "--exclude", "setuptools", "--exclude", "wheel"]
PIN_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s=;]+)$")
REQUIREMENT_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:(>=|==)\s*([^\s,;]+))?$")
CONSTRAINTS_LINE = re.compile(r"^-c\s+\S+$")


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def _content_lines(text):
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if line:
            yield number, line


def parse_pins(text, label):
    """Return ({canonical name: version}, [errors]) for a file of name==version lines."""
    pins, errors = {}, []
    for number, line in _content_lines(text):
        match = PIN_LINE.match(line)
        if not match:
            errors.append(f"{label}:{number}: not a name==version line: {line}")
            continue
        name = canonical(match.group(1))
        if name in pins:
            errors.append(f"{label}:{number}: duplicate line for {name}")
            continue
        pins[name] = match.group(2)
    return pins, errors


def parse_requirements(text, label):
    """Return ([(canonical name, ">=" or "==" or None, version or None)], [errors]) for a file of name[extras],
    name[extras]>=floor and name[extras]==version lines; a -c constraints line is skipped."""
    requirements, errors = [], []
    for number, line in _content_lines(text):
        if CONSTRAINTS_LINE.match(line):
            continue
        match = REQUIREMENT_LINE.match(line)
        if not match:
            errors.append(f"{label}:{number}: not a name, name>=floor or name==version line: {line}")
            continue
        requirements.append((canonical(match.group(1)), match.group(3), match.group(4)))
    return requirements, errors


def version_tuple(version):
    """Release numbers as an int tuple; None when any part is not a plain integer (the check then fails closed)."""
    parts = version.split(".")
    if not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def at_or_above(version, floor):
    have, need = version_tuple(version), version_tuple(floor)
    if have is None or need is None:
        return None
    width = max(len(have), len(need))
    return have + (0,) * (width - len(have)) >= need + (0,) * (width - len(need))


def compare(pin_text, freeze_text, requirements_text=None):
    """Return the list of problems; empty means the installed set matches PIN (and PIN meets the requirements)."""
    pins, problems = parse_pins(pin_text, "PIN")
    installed, freeze_errors = parse_pins(freeze_text, "freeze")
    problems += freeze_errors
    for name in sorted(installed.keys() - pins.keys()):
        problems.append(f"installed but not in PIN: {name}=={installed[name]}")
    for name in sorted(pins.keys() - installed.keys()):
        problems.append(f"in PIN but not installed: {name}=={pins[name]}")
    for name in sorted(pins.keys() & installed.keys()):
        if pins[name] != installed[name]:
            problems.append(f"version differs: {name} PIN {pins[name]}, installed {installed[name]}")
    if requirements_text is not None:
        requirements, requirement_errors = parse_requirements(requirements_text, "requirements")
        problems += requirement_errors
        for name, operator, version in requirements:
            if name not in pins:
                problems.append(f"required but not in PIN: {name}")
            elif operator == "==":
                if pins[name] != version:
                    problems.append(f"PIN differs from the requirement's pin: {name} PIN {pins[name]}, required {version}")
            elif operator == ">=":
                ok = at_or_above(pins[name], version)
                if ok is None:
                    problems.append(f"cannot compare versions: {name} PIN {pins[name]}, floor {version}")
                elif not ok:
                    problems.append(f"PIN below the requirement's floor: {name} PIN {pins[name]}, floor {version}")
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("pin", help="constraints file of name==version lines")
    parser.add_argument("--requirements", help="requirements file whose names and >= floors PIN must cover")
    args = parser.parse_args(argv)
    with open(args.pin, encoding="utf-8") as handle:
        pin_text = handle.read()
    requirements_text = None
    if args.requirements:
        with open(args.requirements, encoding="utf-8") as handle:
            requirements_text = handle.read()
    freeze = subprocess.run([sys.executable, *FREEZE_ARGS], check=True, capture_output=True, text=True).stdout
    problems = compare(pin_text, freeze, requirements_text)
    if not problems:
        print(f"{args.pin}: the installed packages match, {len(parse_pins(pin_text, 'PIN')[0])} pinned")
        return 0
    print(f"{args.pin}: the installed packages do not match", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    print("Installed (pip freeze --all --exclude pip --exclude setuptools --exclude wheel):", file=sys.stderr)
    print(freeze, end="", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
