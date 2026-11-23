#!/usr/bin/env python3
"""Checks for scripts/ci/hive_test_timeout.py, the per-test limit of hive CI's pytest runs: it guards a test whose
setup or call failed (pytest's faulthandler_timeout does not), names the test and its phase, kills the test's child
processes, and ends the run in seconds."""

import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CI = ROOT / "scripts" / "ci"
sys.path.insert(0, str(CI))

import hive_test_timeout  # noqa: E402

# Long enough for a cold start of pytest before the limit counts, short enough that the checks stay quick.
LIMIT = "2"
# A run that the plugin ends must be over well before this. A hang would take much longer.
BOUND = 30


def run(parts, *opts, env_limit=LIMIT):
    """Run pytest with the plugin on a test file made of parts (each dedented on its own)."""
    with tempfile.TemporaryDirectory() as tmp:
        test = pathlib.Path(tmp, "test_case.py")
        test.write_text("".join(textwrap.dedent(p) for p in ([parts] if isinstance(parts, str) else parts)))
        env = dict(os.environ, PYTHONPATH=str(CI), PIDFILE=str(pathlib.Path(tmp, "child.pid")))
        env.pop(hive_test_timeout.ENV, None)
        if env_limit is not None:
            env[hive_test_timeout.ENV] = env_limit
        start = time.monotonic()
        # capture_output: the run returns only when every holder of its stdout and stderr has closed them, so a
        # child left alive with them open would show as a timeout here.
        out = subprocess.run([sys.executable, "-m", "pytest", "-v", "-p", "no:cacheprovider", "-p", "hive_test_timeout",
                              *opts, str(test)], capture_output=True, text=True, timeout=BOUND, env=env, cwd=tmp)
        took = time.monotonic() - start
        pidfile = pathlib.Path(env["PIDFILE"])
        child = int(pidfile.read_text()) if pidfile.exists() else None
    return out, took, child


SLOW_TEARDOWN = """
    import time, pytest

    @pytest.fixture
    def slow_teardown():
        yield
        time.sleep(120)
"""


class TimeoutTest(unittest.TestCase):
    def assertEnded(self, out, took, nodeid, phase):
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertLess(took, BOUND)
        self.assertIn(f"hive_test_timeout: {nodeid} ran past {LIMIT} s, in its {phase}", out.stderr)
        self.assertIn("most recent call first", out.stderr)  # faulthandler's stack dump

    def test_a_failed_test_hanging_in_teardown_is_still_ended_and_named(self):
        out, took, _ = run([SLOW_TEARDOWN, """
            def test_fails(slow_teardown):
                assert False
        """])
        self.assertEnded(out, took, "test_case.py::test_fails", "teardown")

    def test_a_test_hanging_in_its_call_is_ended_and_named(self):
        out, took, _ = run("""
            import time

            def test_ok():
                pass

            def test_hangs():
                time.sleep(120)
        """)
        self.assertEnded(out, took, "test_case.py::test_hangs", "call")
        self.assertIn("test_case.py::test_ok PASSED", out.stdout)

    def test_a_child_in_its_own_session_is_killed_and_releases_the_output(self):
        out, took, child = run("""
            import os, subprocess, sys, time

            def test_waits_on_a_stuck_child():
                p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
                open(os.environ["PIDFILE"], "w").write(str(p.pid))
                p.wait()
        """)
        self.assertEnded(out, took, "test_case.py::test_waits_on_a_stuck_child", "call")
        self.assertIsNotNone(child)
        self.assertIn(str(child), out.stderr)
        # The child was SIGKILLed. Once pytest has gone it is reaped by init or a subreaper, so it is gone or a zombie.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                state = pathlib.Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except OSError:
                break
            if state == "Z":
                break
            time.sleep(0.1)
        else:
            self.fail(f"child {child} still alive")

    def test_tests_within_the_limit_run_as_without_it(self):
        out, took, _ = run([SLOW_TEARDOWN.replace("120", "0.1"), """
            def test_a(slow_teardown):
                pass

            def test_b():
                assert False
        """])
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertIn("1 failed, 1 passed", out.stdout)
        self.assertNotIn("hive_test_timeout:", out.stdout + out.stderr)

    def test_the_limit_is_required_and_positive(self):
        for value in (None, "0", "-3", "five"):
            with self.subTest(value=value):
                out, _, _ = run("def test_x(): pass\n", env_limit=value)
                self.assertEqual(out.returncode, 4, out.stdout + out.stderr)
                self.assertIn(hive_test_timeout.ENV, out.stderr)

    def test_faulthandler_timeout_beside_it_is_refused(self):
        out, _, _ = run("def test_x(): pass\n", "-o", "faulthandler_timeout=300")
        self.assertEqual(out.returncode, 4, out.stdout + out.stderr)
        self.assertIn("drop -o faulthandler_timeout", out.stderr)


class DescendantsTest(unittest.TestCase):
    def test_reads_the_tree_from_proc_and_names_with_spaces_and_parens(self):
        with tempfile.TemporaryDirectory() as proc:
            for pid, name, ppid in [(10, "a", 1), (11, "b (x) y", 10), (12, "c", 11), (13, "d", 1), (14, ")", 10)]:
                os.makedirs(f"{proc}/{pid}")
                pathlib.Path(f"{proc}/{pid}/stat").write_text(f"{pid} ({name}) S {ppid} 0 0\n")
            os.makedirs(f"{proc}/self")
            self.assertEqual(sorted(hive_test_timeout.descendants(10, proc)), [11, 12, 14])
            self.assertEqual(hive_test_timeout.descendants(12, proc), [])

    def test_no_proc_finds_none(self):
        self.assertEqual(hive_test_timeout.descendants(1, "/nonexistent-proc"), [])


if __name__ == "__main__":
    unittest.main()
