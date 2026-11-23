#!/usr/bin/env python3
"""Checks for scripts/dev/check_ci_constraints.py, the guard that CI installs exactly hive/ci-constraints.txt."""

import contextlib
import importlib.util
import io
import pathlib
import subprocess
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_ci_constraints", ROOT / "scripts" / "dev" / "check_ci_constraints.py")
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

PIN = "# header\n\nanyio==4.16.0\npyyaml==6.0.3  # trailing comment\ntyping-extensions==4.16.0\nuvicorn==0.54.0\n"
FREEZE = "anyio==4.16.0\nPyYAML==6.0.3\ntyping_extensions==4.16.0\nuvicorn==0.54.0\n"


class CompareTests(unittest.TestCase):
    def test_matching_sets_pass_with_names_canonicalized(self):
        self.assertEqual(check.compare(PIN, FREEZE), [])

    def test_installed_package_without_a_line_fails(self):
        problems = check.compare(PIN, FREEZE + "janus-swi==1.5.3\n")
        self.assertEqual(problems, ["installed but not in PIN: janus-swi==1.5.3"])

    def test_line_for_a_package_not_installed_fails(self):
        problems = check.compare(PIN, FREEZE.replace("anyio==4.16.0\n", ""))
        self.assertEqual(problems, ["in PIN but not installed: anyio==4.16.0"])

    def test_wrong_version_fails(self):
        problems = check.compare(PIN, FREEZE.replace("anyio==4.16.0", "anyio==4.15.1"))
        self.assertEqual(problems, ["version differs: anyio PIN 4.16.0, installed 4.15.1"])

    def test_line_that_is_not_name_equals_version_fails(self):
        problems = check.compare(PIN + "httpx>=0.27\n", FREEZE)
        self.assertEqual(len(problems), 1)
        self.assertIn("not a name==version line: httpx>=0.27", problems[0])

    def test_duplicate_line_fails_even_when_spelled_differently(self):
        problems = check.compare(PIN + "PyYAML==6.0.3\n", FREEZE)
        self.assertEqual(len(problems), 1)
        self.assertIn("duplicate line for pyyaml", problems[0])

    def test_direct_reference_in_the_freeze_fails_closed(self):
        problems = check.compare(PIN, FREEZE + "local-pkg @ file:///tmp/local_pkg\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("not a name==version line", problems[0])


class AllowExtraTests(unittest.TestCase):
    def test_a_package_beyond_the_pins_passes(self):
        self.assertEqual(check.compare(PIN, FREEZE + "chromadb==1.5.9\n", allow_extra=True), [])

    def test_a_pin_not_installed_still_fails(self):
        freeze = FREEZE.replace("anyio==4.16.0\n", "") + "chromadb==1.5.9\n"
        problems = check.compare(PIN, freeze, allow_extra=True)
        self.assertTrue(any("in PIN but not installed: anyio" in p for p in problems), problems)

    def test_a_pin_at_another_version_still_fails(self):
        freeze = FREEZE.replace("anyio==4.16.0", "anyio==4.15.1") + "chromadb==1.5.9\n"
        problems = check.compare(PIN, freeze, allow_extra=True)
        self.assertTrue(any("version differs: anyio" in p for p in problems), problems)

    def test_an_unparsable_freeze_line_still_fails(self):
        problems = check.compare(PIN, FREEZE + "local-pkg @ file:///tmp/local_pkg\n", allow_extra=True)
        self.assertTrue(problems)


class RequirementsTests(unittest.TestCase):
    def test_requirements_met_with_extras_stripped(self):
        requirements = "anyio>=4\nuvicorn[standard]>=0.27\nPyYAML\n"
        self.assertEqual(check.compare(PIN, FREEZE, requirements), [])

    def test_required_name_missing_from_pin_fails(self):
        problems = check.compare(PIN, FREEZE, "anyio>=4\npillow>=10\n")
        self.assertEqual(problems, ["required but not in PIN: pillow"])

    def test_pin_below_floor_fails(self):
        problems = check.compare(PIN, FREEZE, "uvicorn[standard]>=0.60\n")
        self.assertEqual(problems, ["PIN below the requirement's floor: uvicorn PIN 0.54.0, floor 0.60"])

    def test_floor_compares_numerically_not_as_text(self):
        self.assertEqual(check.compare(PIN, FREEZE, "uvicorn>=0.9\n"), [])
        self.assertEqual(check.compare(PIN, FREEZE, "anyio>=4.16\n"), [])

    def test_unparsable_version_fails_closed(self):
        problems = check.compare(PIN.replace("anyio==4.16.0", "anyio==4.16.0rc1"),
                                 FREEZE.replace("anyio==4.16.0", "anyio==4.16.0rc1"), "anyio>=4\n")
        self.assertEqual(problems, ["cannot compare versions: anyio PIN 4.16.0rc1, floor 4"])

    def test_requirement_line_with_another_operator_fails(self):
        problems = check.compare(PIN, FREEZE, "anyio<5\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("not a name, name>=floor or name==version line: anyio<5", problems[0])

    def test_exact_requirement_met_by_the_same_pin(self):
        self.assertEqual(check.compare(PIN, FREEZE, "anyio==4.16.0\nuvicorn[standard]==0.54.0\n"), [])

    def test_exact_requirement_another_version_fails(self):
        problems = check.compare(PIN, FREEZE, "anyio==4.15.1\n")
        self.assertEqual(problems, ["PIN differs from the requirement's pin: anyio PIN 4.16.0, required 4.15.1"])

    def test_constraints_line_adds_no_requirement(self):
        # pip applies a -c file at install; the PIN-against-freeze half already checks what it installed
        self.assertEqual(check.compare(PIN, FREEZE, "-c google-constraints.txt\nanyio>=4\n"), [])

    def test_other_option_line_fails_closed(self):
        problems = check.compare(PIN, FREEZE, "-r more-requirements.txt\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("not a name, name>=floor or name==version line: -r more-requirements.txt", problems[0])


class RepositoryFilesTests(unittest.TestCase):
    def test_hive_pin_covers_hive_requirements(self):
        pin = (ROOT / "hive" / "ci-constraints.txt").read_text(encoding="utf-8")
        requirements = (ROOT / "hive" / "requirements.txt").read_text(encoding="utf-8")
        pins, errors = check.parse_pins(pin, "PIN")
        self.assertEqual(errors, [])
        # The PIN against itself as the freeze isolates the requirements half of the check.
        self.assertEqual(check.compare(pin, pin, requirements), [])
        self.assertIn("pytest", pins)


class MainTests(unittest.TestCase):
    def run_main(self, freeze):
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=freeze, stderr="")
        out, err = io.StringIO(), io.StringIO()
        pin_path = ROOT / "hive" / "ci-constraints.txt"
        with mock.patch.object(check.subprocess, "run", return_value=result) as run, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check.main([str(pin_path), "--requirements", str(ROOT / "hive" / "requirements.txt")])
        return code, out.getvalue(), err.getvalue(), run

    def test_main_passes_and_runs_the_documented_freeze(self):
        pin = (ROOT / "hive" / "ci-constraints.txt").read_text(encoding="utf-8")
        freeze = "".join(line + "\n" for line in pin.splitlines() if line and not line.startswith("#"))
        code, out, _, run = self.run_main(freeze)
        self.assertEqual(code, 0)
        self.assertIn(f"{len(freeze.splitlines())} pinned", out)   # every == line of the file, counted, not hard-coded
        self.assertEqual(run.call_args.args[0][1:], check.FREEZE_ARGS)

    def test_main_fails_and_prints_the_freeze(self):
        code, _, err, _ = self.run_main("anyio==4.16.0\n")
        self.assertEqual(code, 1)
        self.assertIn("in PIN but not installed: pytest==9.2.0", err)
        self.assertTrue(err.rstrip().endswith("anyio==4.16.0"))


if __name__ == "__main__":
    unittest.main()
