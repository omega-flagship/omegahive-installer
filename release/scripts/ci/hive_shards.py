#!/usr/bin/env python3
"""Print the hive test modules of one shard of the full run, one per line.

Usage:
    python scripts/ci/hive_shards.py SHARD COUNT

The full run (hive-petta) splits hive/tests into COUNT shards, one job each, so a pull request's smoke waits on
runner 1 for one shard rather than the whole run. Every hive test module (pr_hive_tests.is_hive_test) goes to exactly
one shard, whole, so its fixtures and the order of its tests stay as they are. Modules are dealt largest first, by
their number of test functions, each to the shard with the fewest tests so far, ties going to the lower shard: Graham's
longest-processing-time rule, whose largest shard is at most 4/3 of the best split's.

SHARD runs from 1 to COUNT. The output is sorted, and the same tree always gives the same shards. Standard library
only.
"""

import argparse
import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pr_hive_tests import TESTS, is_hive_test  # noqa: E402  (the one rule for what a hive test module is)


def test_count(source):
    """A module's weight: its test* functions at the top level and the test* methods of its top-level classes, a
    parametrized test counted once."""
    tree = ast.parse(source)
    funcs = (ast.FunctionDef, ast.AsyncFunctionDef)
    count = 0
    for node in tree.body:
        if isinstance(node, funcs) and node.name.startswith("test"):
            count += 1
        elif isinstance(node, ast.ClassDef):
            count += sum(isinstance(item, funcs) and item.name.startswith("test") for item in node.body)
    return count


# Time: m log m comparisons to order the modules + m * COUNT to place them, m = the number of modules. Space: m.
def shards(weights, count):
    """Split {module: weight} into `count` lists by the longest-processing-time rule, each list sorted."""
    totals = [0] * count
    parts = [[] for _ in range(count)]
    for module, weight in sorted(weights.items(), key=lambda item: (-item[1], item[0])):
        lightest = min(range(count), key=lambda i: (totals[i], i))
        totals[lightest] += weight
        parts[lightest].append(module)
    return [sorted(part) for part in parts]


def hive_modules(root):
    """{path: test count} for every hive test module under `root`, paths relative to it."""
    found = {}
    for path in (root / TESTS).rglob("test_*.py"):
        rel = path.relative_to(root).as_posix()
        if is_hive_test(rel):
            found[rel] = test_count(path.read_text(encoding="utf-8"))
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("shard", type=int, help="which shard to print, from 1")
    parser.add_argument("count", type=int, help="how many shards")
    args = parser.parse_args(argv)
    if not 1 <= args.shard <= args.count:
        parser.error(f"SHARD must run from 1 to COUNT, got {args.shard} of {args.count}")
    modules = hive_modules(Path.cwd())
    if not modules:
        print(f"no hive test modules under {TESTS}: run this from the repository's root", file=sys.stderr)
        return 2
    for path in shards(modules, args.count)[args.shard - 1]:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
