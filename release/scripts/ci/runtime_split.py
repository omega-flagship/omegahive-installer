#!/usr/bin/env python3
"""Print the runtime tests of one part of the full run's hive-runtime, one pytest node ID or module per line.

Usage:
    python scripts/ci/runtime_split.py PART COUNT WEIGHTS FILE...

The full run's hive-runtime (scripts/ci/runtime-tests.sh) is COUNT jobs, a matrix, and job PART (1 to COUNT) runs the
tests this prints. FILE... are the runtime test modules (scripts/ci/pr_hive_tests.py --runtime --all). A module runs
whole, unless WEIGHTS names it under "by_test": then each of its tests is a unit of its own, as
FILE::Class::test_name or FILE::test_name, so one long module spreads over the parts. The units are dealt largest
first by their seconds in WEIGHTS ("seconds", a module's or a node ID's), each to the part with the least time so far
(hive_shards.shards, the rule hive-petta's split uses); a unit WEIGHTS does not time weighs the median of those it does.

Every part reads the same tree and weights, so the parts are the same split everywhere, and each unit lands in
exactly one part. A part with nothing to run is an error: COUNT is too large for the units. Standard library only.
"""

import argparse
import ast
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hive_shards import shards  # noqa: E402  (the longest-processing-time rule hive-petta's split uses)


def test_ids(path, source):
    """The node IDs of a module's tests: its top-level test* functions and its top-level classes' test* methods."""
    funcs = (ast.FunctionDef, ast.AsyncFunctionDef)
    ids = []
    for node in ast.parse(source).body:
        if isinstance(node, funcs) and node.name.startswith("test"):
            ids.append(f"{path}::{node.name}")
        elif isinstance(node, ast.ClassDef):
            ids += [f"{path}::{node.name}::{item.name}" for item in node.body
                    if isinstance(item, funcs) and item.name.startswith("test")]
    return ids


def units(files, by_test, read):
    """The units to deal: each module whole, or each of its tests for a module in `by_test`."""
    out = []
    for path in files:
        if path in by_test:
            ids = test_ids(path, read(path))
            if not ids:
                raise ValueError(f"{path} is split by test but has no test")
            out += ids
        else:
            out.append(path)
    return out


def split(files, count, weights, read):
    """The units of each of `count` parts, each list sorted."""
    by_test = set(weights.get("by_test", []))
    missing = sorted(by_test - set(files))
    if missing:
        raise ValueError(f"split by test but not a runtime test module: {', '.join(missing)}")
    seconds = weights.get("seconds", {})
    found = units(files, by_test, read)
    timed = [seconds[u] for u in found if u in seconds]
    fallback = statistics.median(timed) if timed else 1.0
    parts = shards({u: seconds.get(u, fallback) for u in found}, count)
    empty = [i + 1 for i, part in enumerate(parts) if not part]
    if empty:
        raise ValueError(f"part {empty[0]} of {count} has nothing to run: {len(found)} units for {count} parts")
    return parts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("part", type=int, help="which part to print, from 1")
    parser.add_argument("count", type=int, help="how many parts")
    parser.add_argument("weights", help="the JSON file of by_test modules and seconds per unit")
    parser.add_argument("files", nargs="+", help="the runtime test modules")
    args = parser.parse_args(argv)
    if not 1 <= args.part <= args.count:
        parser.error(f"PART must run from 1 to COUNT, got {args.part} of {args.count}")
    with open(args.weights, encoding="utf-8") as fh:
        weights = json.load(fh)
    try:
        parts = split(args.files, args.count, weights, lambda p: Path(p).read_text(encoding="utf-8"))
    except ValueError as exc:
        print(f"runtime_split: {exc}", file=sys.stderr)
        return 2
    for unit in parts[args.part - 1]:
        print(unit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
