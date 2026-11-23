#!/usr/bin/env python3
"""Checks for scripts/ci/runtime_split.py, which deals the full run's runtime tests over hive-runtime's parts: every
unit in exactly one part, a module split by test as its node IDs, the same input always giving the same parts, and an
error rather than a part with nothing to run."""

import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci" / "runtime_split.py"
SPEC = importlib.util.spec_from_file_location("runtime_split", SCRIPT)
runtime_split = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_split)

LONG = (
    "import unittest\n"
    "def helper(): pass\n"
    "def test_top(): pass\n"
    "class Slow(unittest.TestCase):\n"
    "    def setUp(self): pass\n"
    "    def test_a(self): pass\n"
    "    def test_b(self): pass\n"
    "    def test_c(self): pass\n"
    "class Helper:\n"
    "    def build(self): pass\n"
)
SOURCES = {"tests/test_long.py": LONG, "tests/test_one.py": "def test_x(): pass\n",
           "tests/test_two.py": "def test_y(): pass\n"}
FILES = sorted(SOURCES)
WEIGHTS = {
    "by_test": ["tests/test_long.py"],
    "seconds": {
        "tests/test_long.py::test_top": 1.0,
        "tests/test_long.py::Slow::test_a": 60.0,
        "tests/test_long.py::Slow::test_b": 50.0,
        "tests/test_long.py::Slow::test_c": 40.0,
        "tests/test_one.py": 30.0,
        "tests/test_two.py": 20.0,
    },
}
LONG_IDS = ["tests/test_long.py::Slow::test_a", "tests/test_long.py::Slow::test_b",
            "tests/test_long.py::Slow::test_c", "tests/test_long.py::test_top"]


def split(files=FILES, count=2, weights=WEIGHTS, sources=SOURCES):
    return runtime_split.split(files, count, weights, sources.__getitem__)


class SplitTests(unittest.TestCase):
    def test_every_unit_lands_in_exactly_one_part(self):
        for count in (1, 2, 3, 4):
            with self.subTest(count=count):
                parts = split(count=count)
                self.assertEqual(len(parts), count)
                dealt = [u for part in parts for u in part]
                self.assertEqual(sorted(dealt), sorted(LONG_IDS + ["tests/test_one.py", "tests/test_two.py"]))

    def test_a_module_split_by_test_is_its_node_ids_and_others_stay_whole(self):
        dealt = {u for part in split() for u in part}
        self.assertNotIn("tests/test_long.py", dealt)
        self.assertTrue(set(LONG_IDS) <= dealt)
        self.assertIn("tests/test_one.py", dealt)
        self.assertFalse(any("helper" in u or "setUp" in u or "build" in u for u in dealt))

    def test_parts_are_dealt_by_seconds_largest_first(self):
        # 60 | 50; 40 to the 50 (90); 30 to the 60 (90); 20 to one 90 (110); 1 to the other (91). The rule, not the
        # optimum (100 | 101): hive_shards.shards, as hive-petta's split.
        totals = sorted(sum(WEIGHTS["seconds"][u] for u in part) for part in split())
        self.assertEqual(totals, [91.0, 110.0])

    def test_the_same_input_gives_the_same_parts(self):
        self.assertEqual(split(), split())
        self.assertEqual(split(files=list(reversed(FILES))), split())

    def test_a_by_test_module_that_is_not_a_runtime_module_is_an_error(self):
        weights = dict(WEIGHTS, by_test=["tests/test_long.py", "tests/test_gone.py"])
        with self.assertRaisesRegex(ValueError, "tests/test_gone.py"):
            split(weights=weights)

    def test_a_by_test_module_without_tests_is_an_error(self):
        sources = dict(SOURCES, **{"tests/test_long.py": "def helper(): pass\n"})
        with self.assertRaisesRegex(ValueError, "no test"):
            split(sources=sources)

    def test_a_part_with_nothing_to_run_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "nothing to run"):
            split(count=7)

    def test_an_untimed_unit_weighs_the_median_of_the_timed(self):
        seconds = {"tests/test_one.py": 10.0, "tests/test_two.py": 30.0, "tests/test_long.py::test_top": 20.0}
        weights = {"by_test": ["tests/test_long.py"], "seconds": seconds}
        parts = split(count=4, weights=weights)
        # Median 20: test_two (30) and the three 20s; the untimed Slow tests each take a part of their own after 30.
        self.assertEqual(len([p for p in parts if p]), 4)
        totals = sorted(sum(seconds.get(u, 20.0) for u in part) for part in parts)
        self.assertEqual(sum(totals), 10.0 + 30.0 + 20.0 + 3 * 20.0)
        self.assertLessEqual(max(totals) - min(totals), 20.0)


class CommandTests(unittest.TestCase):
    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = runtime_split.main(list(args))
            except SystemExit as exc:
                rc = exc.code
        return rc, out.getvalue().splitlines(), err.getvalue()

    def test_the_parts_printed_cover_the_files_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            files = []
            for name, source in SOURCES.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding="utf-8")
                files.append(str(path))
            long_path = str(root / "tests/test_long.py")
            weights = {"by_test": [long_path], "seconds": {}}
            weights_file = root / "weights.json"
            weights_file.write_text(json.dumps(weights), encoding="utf-8")
            printed = []
            for part in (1, 2):
                rc, lines, _ = self.run_main(str(part), "2", str(weights_file), *files)
                self.assertEqual(rc, 0)
                self.assertTrue(lines)
                printed += lines
            self.assertEqual(len(printed), len(set(printed)))
            self.assertEqual(len(printed), 6)
            self.assertIn(f"{long_path}::Slow::test_a", printed)

    def test_a_part_out_of_range_is_refused(self):
        rc, _, _ = self.run_main("3", "2", "weights.json", "tests/test_one.py")
        self.assertEqual(rc, 2)

    def test_an_empty_part_exits_2_with_the_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "test_one.py"
            path.write_text("def test_x(): pass\n", encoding="utf-8")
            weights_file = pathlib.Path(tmp) / "weights.json"
            weights_file.write_text("{}", encoding="utf-8")
            rc, lines, err = self.run_main("1", "2", str(weights_file), str(path))
        self.assertEqual(rc, 2)
        self.assertEqual(lines, [])
        self.assertIn("nothing to run", err)


class RepositoryWeightsTests(unittest.TestCase):
    def test_the_weights_file_splits_the_runtime_modules_named_in_it(self):
        weights = json.loads((ROOT / "scripts/ci/runtime-test-weights.json").read_text(encoding="utf-8"))
        for module in weights["by_test"]:
            with self.subTest(module=module):
                self.assertTrue((ROOT / module).is_file())
                ids = runtime_split.test_ids(module, (ROOT / module).read_text(encoding="utf-8"))
                self.assertTrue(ids)


if __name__ == "__main__":
    unittest.main()
