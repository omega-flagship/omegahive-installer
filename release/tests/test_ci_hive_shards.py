#!/usr/bin/env python3
"""Checks for scripts/ci/hive_shards.py, which splits hive/tests into the full run's shards: every module in exactly
one shard, balanced by test count with the longest-processing-time rule, the same tree always giving the same shards."""

import contextlib
import importlib.util
import io
import itertools
import os
import pathlib
import random
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci" / "hive_shards.py"
SPEC = importlib.util.spec_from_file_location("hive_shards", SCRIPT)
hive_shards = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hive_shards)


def optimal_largest(weights, count):
    """The smallest possible largest shard total, by trying every assignment (small inputs only)."""
    values = list(weights.values())
    best = sum(values)
    for assignment in itertools.product(range(count), repeat=len(values)):
        totals = [0] * count
        for shard, value in zip(assignment, values):
            totals[shard] += value
        best = min(best, max(totals))
    return best


class CountTests(unittest.TestCase):
    def test_top_level_tests_and_test_methods_of_top_level_classes_count(self):
        source = (
            "import pytest\n"
            "def test_a(): pass\n"
            "async def test_b(): pass\n"
            "@pytest.mark.parametrize('x', [1, 2, 3])\n"
            "def test_c(x): pass\n"
            "def helper(): pass\n"
            "class TestThing:\n"
            "    def test_d(self): pass\n"
            "    async def test_e(self): pass\n"
            "    def setup_method(self): pass\n"
            "def outer():\n"
            "    def test_nested(): pass\n"
        )
        self.assertEqual(hive_shards.test_count(source), 5)

    def test_a_module_without_tests_weighs_nothing(self):
        self.assertEqual(hive_shards.test_count("X = 1\n"), 0)


class ShardTests(unittest.TestCase):
    def test_largest_first_to_the_lightest_shard_ties_to_the_lower_shard(self):
        weights = {"m/a.py": 5, "m/b.py": 4, "m/c.py": 3, "m/d.py": 3, "m/e.py": 3}
        # a to 1 (a tie goes to the lower shard), b to 2, c to 2 (4 < 5), d to 1 (5 < 7), e to 2 (7 < 8): totals 8 and
        # 10, where 9 and 9 was possible, within the rule's 4/3 bound.
        self.assertEqual(hive_shards.shards(weights, 2), [["m/a.py", "m/d.py"], ["m/b.py", "m/c.py", "m/e.py"]])

    def test_every_module_is_in_exactly_one_shard_whatever_the_count(self):
        rng = random.Random(7)
        for trial in range(200):
            weights = {f"hive/tests/test_{i}.py": rng.randint(0, 40) for i in range(rng.randint(1, 30))}
            for count in (1, 2, 3, 4, 7, 40):
                parts = hive_shards.shards(weights, count)
                self.assertEqual(len(parts), count)
                flat = [m for part in parts for m in part]
                self.assertEqual(sorted(flat), sorted(weights), (trial, count))
                self.assertEqual(len(flat), len(set(flat)), (trial, count))
                self.assertTrue(all(part == sorted(part) for part in parts))

    def test_the_same_modules_give_the_same_shards_in_any_order(self):
        weights = {f"hive/tests/test_{i}.py": i % 5 for i in range(25)}
        shuffled = list(weights.items())
        random.Random(3).shuffle(shuffled)
        self.assertEqual(hive_shards.shards(weights, 4), hive_shards.shards(dict(shuffled), 4))

    def test_the_largest_shard_is_within_four_thirds_of_the_best_split(self):
        rng = random.Random(11)
        for trial in range(300):
            weights = {f"t{i}": rng.randint(1, 30) for i in range(rng.randint(1, 8))}
            count = rng.randint(2, 3)
            parts = hive_shards.shards(weights, count)
            largest = max(sum(weights[m] for m in part) for part in parts)
            best = optimal_largest(weights, count)
            self.assertLessEqual(3 * largest, 4 * best, (trial, weights, count, parts))


class CommandTests(unittest.TestCase):
    def run_main(self, root, *argv):
        out, err = io.StringIO(), io.StringIO()
        cwd = os.getcwd()
        os.chdir(root)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = hive_shards.main(list(argv))
                except SystemExit as stop:
                    code = stop.code
        finally:
            os.chdir(cwd)
        return code, out.getvalue().split(), err.getvalue()

    def test_the_shards_of_a_tree_print_every_hive_test_module_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            tests = root / "hive" / "tests"
            (tests / "sub").mkdir(parents=True)
            for name, n in (("test_a.py", 3), ("test_b.py", 1), ("sub/test_c.py", 2), ("test_d.py", 2)):
                (tests / name).write_text("".join(f"def test_{i}(): pass\n" for i in range(n)), encoding="utf-8")
            (tests / "conftest.py").write_text("def test_not_a_module(): pass\n", encoding="utf-8")
            (tests / "helpers.py").write_text("X = 1\n", encoding="utf-8")
            printed = []
            for shard in ("1", "2"):
                code, lines, _ = self.run_main(root, shard, "2")
                self.assertEqual(code, 0)
                self.assertEqual(lines, sorted(lines))
                printed += lines
            self.assertEqual(sorted(printed), ["hive/tests/sub/test_c.py", "hive/tests/test_a.py",
                                               "hive/tests/test_b.py", "hive/tests/test_d.py"])

    def test_a_shard_outside_one_to_count_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            for argv in (("0", "4"), ("5", "4")):
                code, lines, err = self.run_main(tmp, *argv)
                self.assertEqual(code, 2)
                self.assertEqual(lines, [])
                self.assertIn("SHARD must run from 1 to COUNT", err)

    def test_no_hive_test_modules_is_an_error_not_an_empty_shard(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, lines, err = self.run_main(tmp, "1", "1")
            self.assertEqual(code, 2)
            self.assertIn("no hive test modules", err)

    def test_this_trees_shards_cover_every_hive_test_module(self):
        modules = hive_shards.hive_modules(ROOT)
        self.assertTrue(modules)
        parts = hive_shards.shards(modules, 4)
        self.assertEqual(sorted(m for part in parts for m in part), sorted(modules))


if __name__ == "__main__":
    sys.exit(unittest.main())
