#!/usr/bin/env python3
"""Checks for scripts/ci/pr_hive_tests.py, which picks the tests a pull request's hive-petta-smoke runs beyond its
fixed selection: the hive test modules it adds or changes, and tests/'s runtime tests when it touches the runtime."""

import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci" / "pr_hive_tests.py"
SPEC = importlib.util.spec_from_file_location("pr_hive_tests", SCRIPT)
pr_tests = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pr_tests)

# Git in the throwaway repositories below reads no user or system configuration and runs no hooks, so a developer's
# global hooks or signing settings cannot change what the test sees.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                          check=True, capture_output=True, text=True, env=GIT_ENV).stdout


def write(repo, path, text):
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


class RuleTests(unittest.TestCase):
    def test_test_modules_under_hive_tests_count_at_any_depth(self):
        for path in ("hive/tests/test_rooms.py", "hive/tests/sub/test_flow.py", "hive/tests/a/b/test_deep.py"):
            self.assertTrue(pr_tests.is_hive_test(path), path)

    def test_helpers_data_and_other_folders_do_not_count(self):
        for path in ("hive/tests/conftest.py", "hive/tests/helpers.py", "hive/tests/fixtures/test_data.json",
                     "hive/tests/test_rooms.txt", "tests/test_core_dependency.py", "hive/test_rooms.py",
                     "hive/testsuite/test_rooms.py", "hive/ui/src/rooms.test.ts", "hive/tests"):
            self.assertFalse(pr_tests.is_hive_test(path), path)

    def test_selection_is_sorted_without_repeats_and_keeps_only_existing_files(self):
        paths = ["hive/tests/test_b.py", "hive/tests/test_a.py", "hive/tests/conftest.py", "hive/tests/test_b.py",
                 "hive/tests/test_gone.py"]
        exists = lambda p: p != "hive/tests/test_gone.py"
        self.assertEqual(pr_tests.select(paths, exists), ["hive/tests/test_a.py", "hive/tests/test_b.py"])

    def test_nothing_selected_is_an_empty_list(self):
        self.assertEqual(pr_tests.select(["hive/tests/conftest.py", "README.md"], lambda p: True), [])


class RuntimeRuleTests(unittest.TestCase):
    def test_the_runtime_its_programs_packages_and_ci_touch_it(self):
        for path in ("core-dependency.json", "third_party/Omega", "hive/runtime/native_core.py",
                     "hive/runtime/extensions/loop_hooks.metta", "modules/vm/policy.metta", "channels/hive.py",
                     "lib_omegaclaw.metta", "run.metta", "src/loop.metta", "scripts/setup_core.py", "requirements.txt",
                     "hive/requirements.txt", "tests/ci-requirements.txt",
                     "tests/ci-runtime-requirements.txt", "hive/ci-constraints.txt",
                     "tests/wait_quiet_runtime_smoke.metta", ".github/workflows/ci.yml",
                     ".github/actions/petta-toolchain/action.yml", "scripts/ci/runtime-tests.sh",
                     "scripts/dev/setup_petta_env.sh"):
            self.assertTrue(pr_tests.touches_runtime([path], set()), path)

    def test_the_hive_server_its_tests_and_docs_do_not(self):
        for path in ("hive/core/app.py", "hive/tests/test_rooms.py", "hive/ui/src/rooms.ts", "docs/MODULARITY.md",
                     "tests/test_core_dependency.py", "hive/lib_rooms.metta", "README.md"):
            self.assertFalse(pr_tests.touches_runtime([path], set()), path)

    def test_the_tests_modules_a_runtime_test_imports_are_found_through_each_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            write(root, "tests/test_boot.py", "from hub import FakeHub\nimport tests.wire\nimport hive.runtime.native_core\n")
            write(root, "tests/hub.py", "from frames import Frame\n")
            write(root, "tests/frames.py", "FRAME = 1\n")
            write(root, "tests/wire.py", "WIRE = 1\n")
            write(root, "tests/unused.py", "UNUSED = 1\n")
            self.assertEqual(pr_tests.test_imports(root, ["tests/test_boot.py"]),
                             {"tests/hub.py", "tests/frames.py", "tests/wire.py"})

    def test_a_runtime_test_itself_touches_it(self):
        self.assertTrue(pr_tests.touches_runtime(["tests/test_boot.py"], {"tests/test_boot.py"}))

    def test_runtime_tests_are_the_test_modules_that_read_the_petta_variable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            write(root, "tests/test_boot.py", "import os\nPETTA = os.environ.get('HIVE_TEST_PETTA')\n")
            write(root, "tests/test_plain.py", "def test_plain():\n    pass\n")
            write(root, "tests/test_mentions.py", "DATA = \"os.environ.get('HIVE_TEST_PETTA')\"\n")
            write(root, "tests/boot_helper.py", "import os\nPETTA = os.environ['HIVE_TEST_PETTA']\n")
            self.assertEqual(pr_tests.runtime_tests(root), ["tests/test_boot.py"])

    def test_each_way_of_reading_the_variable_counts(self):
        for source in ("import os\nP = os.environ.get('HIVE_TEST_PETTA', '')\n",
                       "import os\nP = os.environ['HIVE_TEST_PETTA']\n",
                       "import os\nP = os.getenv('HIVE_TEST_PETTA')\n",
                       "from os import environ, getenv\nP = environ.get('HIVE_TEST_PETTA')\nQ = getenv('HIVE_TEST_PETTA')\n"):
            self.assertTrue(pr_tests.reads_mark(source), source)

    def test_mentioning_the_variable_is_not_reading_it(self):
        # tests/test_ci_pr_hive_tests.py itself holds the name in strings like these, and run 43153512772 on runner 1
        # took it for a runtime test while the rule matched text.
        for source in ("DATA = \"os.environ.get('HIVE_TEST_PETTA')\"\n", "# set HIVE_TEST_PETTA to boot\n",
                       "import os\nP = os.environ.get('HIVE_TEST_OTHER')\n", "def broken(:\n    HIVE_TEST_PETTA\n"):
            self.assertFalse(pr_tests.reads_mark(source), source)
        self.assertNotIn("tests/test_ci_pr_hive_tests.py", pr_tests.runtime_tests(ROOT))


class MergeCommitTests(unittest.TestCase):
    """The script on a pull-request merge commit, as actions/checkout gives it for a pull_request event."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self.tmp.name)
        git(self.repo, "init", "-q", "-b", "main")
        for name in ("test_keep", "test_change", "test_drop", "test_move_from"):
            write(self.repo, f"hive/tests/{name}.py", f"def test_{name}():\n    pass\n")
        write(self.repo, "hive/tests/conftest.py", "# fixtures\n")
        write(self.repo, "hive/tests/helper_util.py", "VALUE = 1\n")
        write(self.repo, "tests/test_root.py", "# root suite\n")
        write(self.repo, "tests/test_boot_runtime.py",
              "import os\nfrom fake_hub import FakeHub\nPETTA = os.environ.get('HIVE_TEST_PETTA')\n")
        write(self.repo, "tests/fake_hub.py", "class FakeHub:\n    pass\n")
        write(self.repo, "hive/runtime/native_core.py", "LOOP = 1\n")
        write(self.repo, "hive/core/app.py", "ROUTES = 1\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "base")
        git(self.repo, "checkout", "-q", "-b", "pr")

    def tearDown(self):
        self.tmp.cleanup()

    def merge_into_moved_base(self):
        """The base branch moves on (a change only it makes), then GitHub's merge commit joins the pull request."""
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "pull request")
        git(self.repo, "checkout", "-q", "main")
        write(self.repo, "hive/tests/test_keep.py", "def test_keep():\n    assert True\n")
        git(self.repo, "commit", "-q", "-am", "base moves on")
        git(self.repo, "merge", "-q", "--no-ff", "--no-edit", "pr")

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.repo, capture_output=True, text=True,
                              env=GIT_ENV)

    def test_added_changed_and_renamed_tests_are_printed_and_the_rest_is_not(self):
        write(self.repo, "hive/tests/test_change.py", "def test_change():\n    assert 1\n")
        (self.repo / "hive/tests/test_drop.py").unlink()
        (self.repo / "hive/tests/sub").mkdir()
        git(self.repo, "mv", "hive/tests/test_move_from.py", "hive/tests/sub/test_move_to.py")
        write(self.repo, "hive/tests/test_new.py", "def test_new():\n    pass\n")
        write(self.repo, "hive/tests/conftest.py", "# fixtures, changed\n")
        write(self.repo, "hive/tests/helper_util.py", "VALUE = 2\n")
        write(self.repo, "tests/test_root2.py", "# root suite, new\n")
        self.merge_into_moved_base()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(),
                         ["hive/tests/sub/test_move_to.py", "hive/tests/test_change.py", "hive/tests/test_new.py"])

    def test_a_pull_request_touching_no_hive_test_module_prints_nothing(self):
        write(self.repo, "hive/tests/conftest.py", "# fixtures, changed\n")
        self.merge_into_moved_base()
        result = self.run_script()
        self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)

    def test_a_base_git_cannot_resolve_fails_instead_of_selecting_nothing(self):
        write(self.repo, "hive/tests/test_new.py", "def test_new():\n    pass\n")
        self.merge_into_moved_base()
        self.assertEqual(self.run_script().stdout, "hive/tests/test_new.py\n")
        result = self.run_script("no-such-revision")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("git diff no-such-revision HEAD failed", result.stderr)


    def test_runtime_tests_run_when_the_pull_request_touches_the_runtime(self):
        write(self.repo, "hive/runtime/native_core.py", "LOOP = 2\n")
        self.merge_into_moved_base()
        result = self.run_script("--runtime")
        self.assertEqual((result.returncode, result.stdout), (0, "tests/test_boot_runtime.py\n"), result.stderr)

    def test_runtime_tests_run_when_a_tests_module_they_import_changes(self):
        # tests/test_channel_hive.py holds the fake hub test_channel_hive_runtime.py and test_wait_quiet_runtime.py
        # import; a pull request that changes only it still runs them (review of #229).
        write(self.repo, "tests/fake_hub.py", "class FakeHub:\n    port = 1\n")
        self.merge_into_moved_base()
        result = self.run_script("--runtime")
        self.assertEqual((result.returncode, result.stdout), (0, "tests/test_boot_runtime.py\n"), result.stderr)

    def test_runtime_tests_do_not_run_for_a_hive_server_change(self):
        write(self.repo, "hive/core/app.py", "ROUTES = 2\n")
        self.merge_into_moved_base()
        result = self.run_script("--runtime")
        self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)
        result = self.run_script("--runtime", "--all")
        self.assertEqual((result.returncode, result.stdout), (0, "tests/test_boot_runtime.py\n"), result.stderr)


if __name__ == "__main__":
    unittest.main()
