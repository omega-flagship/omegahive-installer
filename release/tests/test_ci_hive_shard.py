#!/usr/bin/env python3
"""Checks for scripts/ci/hive_shard.py, which splits the full run's hive/tests by file across hive-petta's shards, and
scripts/ci/hive_shard_check.py, with which hive-full checks that the shards ran the whole suite once."""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))  # hive_shard imports hive_shards, as `-p hive_shard` does in CI


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / "ci" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shard = load("hive_shard")
shard_check = load("hive_shard_check")


class SplitTest(unittest.TestCase):
    def test_every_file_in_exactly_one_shard_and_balanced(self):
        weights = {f"t{i}.py": w for i, w in enumerate([50, 40, 30, 20, 10, 10, 5, 5, 1])}
        shards, loads = shard.split(weights, 3)
        files = [f for s in shards for f in s]
        self.assertEqual(sorted(files), sorted(weights))
        self.assertEqual(len(files), len(set(files)))
        self.assertLessEqual(max(loads) - min(loads), 10)

    def test_same_input_same_split_whatever_the_order(self):
        weights = {f"t{i}.py": 1 for i in range(20)}
        reordered = dict(reversed(list(weights.items())))
        self.assertEqual(shard.split(weights, 8), shard.split(reordered, 8))

    def test_more_shards_than_files_leaves_some_empty(self):
        shards, _ = shard.split({"a.py": 1, "b.py": 2}, 4)
        self.assertEqual(sum(len(s) for s in shards), 2)

    def test_weights_fall_back_to_counts_times_the_median(self):
        counts = {"a.py": 10, "b.py": 4, "new.py": 3}
        w = shard.weights_for(counts, {"a.py": 20.0, "b.py": 4.0, "gone.py": 99})
        self.assertEqual(w, {"a.py": 20.0, "b.py": 4.0, "new.py": 3 * 1.5})
        self.assertEqual(shard.weights_for(counts), {"a.py": 10, "b.py": 4, "new.py": 3})

    def test_switch_files_make_the_last_shard_and_leave_the_split(self):
        weights = {"a.py": 5, "b.py": 4, "c.py": 3, "s1.py": 50, "s2.py": 1}
        parts, loads = shard.split_with_switch(weights, 3, ["s2.py", "s1.py"])
        self.assertEqual(parts[-1], ["s1.py", "s2.py"])
        self.assertEqual(loads[-1], 51)
        self.assertEqual(sorted(f for p in parts[:-1] for f in p), ["a.py", "b.py", "c.py"])
        self.assertEqual(parts[:-1], shard.split({"a.py": 5, "b.py": 4, "c.py": 3}, 2)[0])

    def test_a_switch_file_the_suite_did_not_collect_fails(self):
        import pytest
        with self.assertRaisesRegex(pytest.UsageError, "gone.py"):
            shard.split_with_switch({"a.py": 1}, 2, ["gone.py"])

    def test_a_switch_shard_needs_a_plain_shard_beside_it(self):
        import pytest
        with self.assertRaisesRegex(pytest.UsageError, "at least 2"):
            shard.split_with_switch({"a.py": 1, "s.py": 1}, 1, ["s.py"])

    def test_the_switch_list_reads_paths_and_skips_comments(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
            fh.write("# a comment\n\nhive/tests/test_x.py  # why\n  hive/tests/test_y.py\n")
        try:
            self.assertEqual(shard.read_switch_files(fh.name), ["hive/tests/test_x.py", "hive/tests/test_y.py"])
        finally:
            os.unlink(fh.name)

    def test_the_tree_switch_list_names_files_that_exist(self):
        files = shard.read_switch_files(ROOT / "scripts" / "ci" / "hive-switch-files.txt")
        self.assertTrue(files)
        for f in files:
            self.assertTrue((ROOT / f).is_file(), f)

    def test_parse_shard(self):
        self.assertEqual(shard.parse_shard("3/8"), (3, 8))
        for bad in ("8/8", "-1/8", "1"):
            with self.assertRaises(ValueError):
                shard.parse_shard(bad)


def report(i, count, files, selected_files):
    return {"shard": i, "count": count, "files": files, "selected_files": selected_files,
            "selected": sum(files[f] for f in selected_files)}


class CheckTest(unittest.TestCase):
    FILES = {"a.py": 3, "b.py": 2, "c.py": 1}
    BUDGET = ["--target-minutes", "25", "--overhead-minutes", "5", "--max-imbalance", "1.3"]   # 20 min per shard

    def good(self):
        reports = {0: report(0, 2, self.FILES, ["a.py"]), 1: report(1, 2, self.FILES, ["b.py", "c.py"])}
        junits = {0: (3, {"a.py": 1.0}), 1: (3, {"b.py": 1.0, "c.py": 1.0})}
        return reports, junits

    def test_full_cover_passes(self):
        problems, facts = shard_check.check(2, *self.good())
        self.assertEqual(problems, [])
        self.assertEqual(facts["collected"], 6)

    def test_suggested_shards_one_per_ten_minutes_of_serial_time(self):
        self.assertEqual(shard_check.suggested_shards(0, 10), 1)
        self.assertEqual(shard_check.suggested_shards(600, 10), 1)
        self.assertEqual(shard_check.suggested_shards(601, 10), 2)
        self.assertEqual(shard_check.suggested_shards(79.1 * 60, 10), 8)   # run 44654841525's serial hive/tests
        self.assertEqual(shard_check.suggested_shards(79.1 * 60, 5), 16)
        self.assertEqual(shard_check.suggested_shards(87.9 * 60, 15 - 6), 10)   # run 44846142867, 6 min of toolchain
        with self.assertRaises(ValueError):
            shard_check.suggested_shards(600, 0)   # a target at or below the overhead leaves no test time

    def test_imbalance_is_the_longest_plain_shard_over_their_mean(self):
        self.assertEqual(shard_check.imbalance([600, 600]), 1.0)
        self.assertEqual(shard_check.imbalance([900, 300]), 1.5)
        self.assertAlmostEqual(shard_check.imbalance([5.1, 6.6, 12.3, 13.5, 11.2, 14.3, 24.3]), 24.3 / (87.3 / 7))
        self.assertEqual(shard_check.imbalance([]), 1.0)       # no plain shard reported
        self.assertEqual(shard_check.imbalance([0.0, 0.0]), 1.0)   # no time measured

    def test_main_prints_the_suggested_count_and_writes_the_summary(self):
        import contextlib
        import io
        from unittest import mock
        reports, _ = self.good()
        with tempfile.TemporaryDirectory() as d:
            for i, r in reports.items():
                folder = os.path.join(d, f"hive-shard-{i}")
                os.makedirs(folder)
                with open(os.path.join(folder, "report.json"), "w") as fh:
                    json.dump(r, fh)
                cases = "".join(f'<testcase file="{f}" name="t{k}" time="400"/>'
                                for f in r["selected_files"] for k in range(self.FILES[f]))
                with open(os.path.join(folder, "junit.xml"), "w") as fh:
                    fh.write(f'<testsuite tests="{r["selected"]}">{cases}</testsuite>')
            summary = os.path.join(d, "summary.md")
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": summary}):
                self.assertEqual(shard_check.main(["2", d, *self.BUDGET]), 0)
            # six tests of 400 s: 40 min of serial test time over 20 min per shard, so two shards
            self.assertIn("suggested HIVE_SHARDS: 2", out.getvalue())
            self.assertIn("plain-shard imbalance 1.00", out.getvalue())
            self.assertNotIn("::warning::", out.getvalue())
            with open(summary) as fh:
                self.assertIn("suggested HIVE_SHARDS: 2", fh.read())

    def test_suggestion_leaves_out_the_switch_shard(self):
        # HIVE_SHARDS is the plain count: the switch shard's time must not raise it, or each run's advice adds one.
        import contextlib
        import io
        files = {"a.py": 3, "b.py": 2, "s.py": 1}
        reports = {0: report(0, 3, files, ["a.py"]), 1: report(1, 3, files, ["b.py"]),
                   2: dict(report(2, 3, files, ["s.py"]), switch=True)}
        with tempfile.TemporaryDirectory() as d:
            for i, r in reports.items():
                folder = os.path.join(d, f"hive-shard-{i}")
                os.makedirs(folder)
                with open(os.path.join(folder, "report.json"), "w") as fh:
                    json.dump(r, fh)
                secs = 3000 if r.get("switch") else 400   # the switch shard alone is 50 min
                cases = "".join(f'<testcase file="{f}" name="t{k}" time="{secs}"/>'
                                for f in r["selected_files"] for k in range(files[f]))
                with open(os.path.join(folder, "junit.xml"), "w") as fh:
                    fh.write(f'<testsuite tests="{r["selected"]}">{cases}</testsuite>')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(shard_check.main(["3", d, *self.BUDGET]), 0)
            # five plain tests of 400 s: 33.3 min, so two plain shards; with the switch shard's 50 min it would be 5
            self.assertIn("suggested HIVE_SHARDS: 2", out.getvalue())
            self.assertIn("shard 2 (switch)", out.getvalue())
            # plain shards of 1200 s and 800 s: 1.2 over their mean; with the switch shard's 3000 s it would be 1.8
            self.assertIn("plain-shard imbalance 1.20", out.getvalue())
            self.assertNotIn("::warning::", out.getvalue())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(shard_check.main(["3", d, "--target-minutes", "25", "--overhead-minutes", "5", "--max-imbalance", "1.1"]), 0)   # a warning, not a failure
            self.assertIn("::warning::the plain shards' imbalance is 1.20, over 1.1", out.getvalue())
            self.assertNotIn("alone takes", out.getvalue())   # s.py's 50 min is the switch shard's, fixed
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                # 15 - 12 = 3 min per shard: a.py's 20 min alone is over it, a warning and not a failure
                self.assertEqual(shard_check.main(["3", d, "--target-minutes", "15", "--overhead-minutes", "12",
                                                   "--max-imbalance", "1.3"]), 0)
            self.assertIn("::warning::a.py alone takes 20.0 min, over the 3 min per shard", out.getvalue())
            self.assertIn("suggested HIVE_SHARDS: 12", out.getvalue())   # 33.3 min over 3 min per shard

    def test_the_budget_numbers_are_required(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                shard_check.main(["2", d, "--target-minutes", "15", "--max-imbalance", "1.3"])

    def test_missing_shard_fails(self):
        reports, junits = self.good()
        del reports[1]
        problems, _ = shard_check.check(2, reports, junits)
        self.assertTrue(any("want 0..1" in p for p in problems))
        self.assertTrue(any("in no shard" in p for p in problems))

    def test_overlap_fails(self):
        reports, junits = self.good()
        reports[1] = report(1, 2, self.FILES, ["a.py", "b.py", "c.py"])
        problems, _ = shard_check.check(2, reports, junits)
        self.assertTrue(any("in shards 0 and 1" in p for p in problems))

    def test_different_suites_fail(self):
        reports, junits = self.good()
        reports[1] = report(1, 2, {**self.FILES, "d.py": 4}, ["b.py", "c.py", "d.py"])
        problems, _ = shard_check.check(2, reports, junits)
        self.assertTrue(any("different suites" in p for p in problems))

    def test_read_junit_counts_distinct_testcases_in_the_shard_files(self):
        # tests= counts the subtests and the module skipped at collection; a teardown error is a second row.
        xml = ('<testsuites><testsuite tests="6">'
               '<testcase classname="" name="suite.test_skip" file="z.py" time="0.000"><skipped/></testcase>'
               '<testcase classname="suite.test_a" name="t0" file="a.py" time="1.0"/>'
               '<testcase classname="suite.test_a" name="t1" file="a.py" time="2.0"/>'
               '<testcase classname="suite.test_a" name="t1" file="a.py" time="0.5"><error/></testcase>'
               '</testsuite></testsuites>')
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "junit.xml")
            with open(path, "w") as fh:
                fh.write(xml)
            self.assertEqual(shard_check.read_junit(path, {"a.py"}), (2, {"a.py": 3.5}))
            self.assertEqual(shard_check.read_junit(path)[0], 3)

    def test_shard_that_stopped_part_way_fails(self):
        reports, junits = self.good()
        junits[0] = (1, {"a.py": 1.0})
        junits[1] = None
        problems, _ = shard_check.check(2, reports, junits)
        self.assertTrue(any("shard 0 reported 1 tests" in p for p in problems))
        self.assertTrue(any("shard 1 left no junit.xml" in p for p in problems))


class PluginRunTest(unittest.TestCase):
    """The plugin in a real pytest run: two shards of a small suite cover it once, and the check agrees."""

    def test_two_shards_cover_a_suite(self):
        try:
            import pytest  # noqa: F401
        except ImportError:
            self.skipTest("pytest is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            suite = pathlib.Path(tmp, "suite")
            suite.mkdir()
            for name, n in (("test_a.py", 3), ("test_b.py", 2), ("test_c.py", 1)):
                suite.joinpath(name).write_text(textwrap.dedent(f"""
                    import pytest
                    @pytest.mark.parametrize("i", range({n}))
                    def test_it(i):
                        pass
                """))
            # skipped at collection, so in every shard's junit and in no shard's selection (run 44793192701's +1)
            suite.joinpath("test_skip.py").write_text(
                "import pytest\npytest.skip('not here', allow_module_level=True)\n")
            out = pathlib.Path(tmp, "out")
            for i in range(2):
                d = out / f"hive-shard-{i}"
                d.mkdir(parents=True)
                env = {**os.environ, "PYTHONPATH": str(ROOT / "scripts" / "ci"), "HIVE_SHARD": f"{i}/2",
                       "HIVE_SHARD_REPORT": str(d / "report.json")}
                subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "hive_shard", "-p", "no:cacheprovider",
                                "-o", "junit_family=xunit1", f"--junitxml={d / 'junit.xml'}", "suite"],
                               cwd=tmp, env=env, check=True, capture_output=True, text=True)
            reports = [json.loads((out / f"hive-shard-{i}" / "report.json").read_text()) for i in range(2)]
            self.assertEqual(sum(r["selected"] for r in reports), 6)
            self.assertEqual(reports[0]["collected"], 6)
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "hive_shard_check.py"), "2",
                                     str(out), "--weights-out", str(out / "weights.json"), *CheckTest.BUDGET],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            weights = json.loads((out / "weights.json").read_text())
            self.assertEqual(sorted(weights), ["suite/test_a.py", "suite/test_b.py", "suite/test_c.py"])

    def test_a_switch_shard_beside_two_plain_ones_covers_the_suite(self):
        try:
            import pytest  # noqa: F401
        except ImportError:
            self.skipTest("pytest is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            suite = pathlib.Path(tmp, "suite")
            suite.mkdir()
            for name in ("test_a.py", "test_b.py", "test_c.py", "test_s.py"):
                suite.joinpath(name).write_text("def test_it():\n    pass\n")
            switch = pathlib.Path(tmp, "switch.txt")
            switch.write_text("# the switch file\nsuite/test_s.py\n")
            out = pathlib.Path(tmp, "out")
            for i in range(3):
                d = out / f"hive-shard-{i}"
                d.mkdir(parents=True)
                env = {**os.environ, "PYTHONPATH": str(ROOT / "scripts" / "ci"), "HIVE_SHARD": f"{i}/3",
                       "HIVE_SHARD_REPORT": str(d / "report.json"), "HIVE_SWITCH_FILES": str(switch)}
                subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "hive_shard", "-p", "no:cacheprovider",
                                "-o", "junit_family=xunit1", f"--junitxml={d / 'junit.xml'}", "suite"],
                               cwd=tmp, env=env, check=True, capture_output=True, text=True)
            reports = [json.loads((out / f"hive-shard-{i}" / "report.json").read_text()) for i in range(3)]
            self.assertEqual(reports[2]["selected_files"], ["suite/test_s.py"])
            self.assertEqual([r["switch"] for r in reports], [False, False, True])
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "hive_shard_check.py"), "3",
                                     str(out), *CheckTest.BUDGET], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
