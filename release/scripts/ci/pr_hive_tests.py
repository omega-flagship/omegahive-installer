#!/usr/bin/env python3
"""Print the tests a pull request's hive-petta-smoke runs beyond its fixed selection, one per line.

Usage:
    python scripts/ci/pr_hive_tests.py [--runtime [--all]] [BASE [HEAD]]

BASE and HEAD default to HEAD^1 and HEAD. On GitHub's pull-request merge commit, which actions/checkout checks out
for a pull_request event, HEAD^1 is the base branch's tip and HEAD is the pull request merged into it, so the
difference is what merging the pull request changes, with no history fetched beyond the merge commit's parents
(checkout fetch-depth 2). A change the base branch made on its own is not part of it.

Without --runtime it prints the hive test modules the pull request adds, changes or renames to: test_*.py under
hive/tests, at any depth, that exist in the working tree. A deleted file is not printed. A change to conftest.py, a
helper module or test data selects nothing, since which tests it reaches is not known here; the full run (hive-petta,
by dispatch) covers it.

With --runtime it prints every runtime test, the tests/test_*.py modules that boot the core runtime through PeTTa
(those that read HIVE_TEST_PETTA, so a new one joins by itself), when the pull request touches what they run: the
runtime or the MeTTa programs they boot, one of those tests or a tests/ module they import, or the CI that runs
them (RUNTIME below). Otherwise it
prints nothing. core-tests cannot run them, having no PeTTa, so this is the only place a pull request runs them.
With --runtime --all it prints every runtime test whatever changed, for the full run (scripts/ci/runtime-tests.sh).

The output is sorted, so a run is reproducible, and empty when nothing qualifies. A git failure, such as a BASE that
was not fetched, fails the script rather than printing nothing. Standard library only.
"""

import argparse
import ast
import fnmatch
import subprocess
import sys
from pathlib import Path, PurePosixPath

TESTS = PurePosixPath("hive/tests")

# What the runtime tests boot and what runs them, as fnmatch patterns over repository paths ("*" also crosses "/").
# The runtime is what docs/MODULARITY.md names: Omega at the pin core-dependency.json sets, in third_party/Omega, and
# the Hive's extensions to it in hive/runtime/, modules/, channels/ and the lib_*.metta shims; with run.metta, src/,
# scripts/setup_core.py (which composes the core), the MeTTa programs the tests boot (tests/*.metta) and the Python
# requirements of the core and of hive. The CI part is the workflow, the petta-toolchain action, these scripts, the
# toolchain's pins and the package lists and constraints the step installs from.
RUNTIME = (
    # the runtime and the MeTTa programs the tests boot
    "core-dependency.json", "third_party/Omega", "hive/runtime/*", "modules/*", "channels/*", "lib_*.metta",
    "run.metta", "src/*", "scripts/setup_core.py", "tests/*.metta",
    # the Python packages it runs on
    "requirements.txt", "hive/requirements.txt", "tests/ci-requirements.txt", "hive/ci-constraints.txt",
    # the CI that runs it
    ".github/workflows/ci.yml", ".github/actions/petta-toolchain/*", "scripts/ci/*", "scripts/dev/setup_petta_env.sh",
)
RUNTIME_MARK = "HIVE_TEST_PETTA"


def is_hive_test(path):
    """Whether a repository path is a test module pytest collects under hive/tests."""
    p = PurePosixPath(path)
    return p.suffix == ".py" and p.name.startswith("test_") and TESTS in p.parents


def select(paths, exists):
    """The hive test modules among `paths` for which `exists` holds, sorted and without repeats."""
    return sorted({p for p in paths if is_hive_test(p) and exists(p)})


def reads_mark(source):
    """Whether Python `source` reads the HIVE_TEST_PETTA variable: os.environ.get(...), os.getenv(...) or
    os.environ[...] with it as the key. The name in a string, as in this script's own tests, does not count."""
    def environ(node):
        return (isinstance(node, ast.Attribute) and node.attr == "environ") or \
            (isinstance(node, ast.Name) and node.id == "environ")

    def mark(node):
        return isinstance(node, ast.Constant) and node.value == RUNTIME_MARK

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return False  # core-tests reports a test module that does not parse
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args and mark(node.args[0]):
            f = node.func
            if (isinstance(f, ast.Attribute) and (f.attr == "getenv" or f.attr == "get" and environ(f.value))) or \
                    (isinstance(f, ast.Name) and f.id == "getenv"):
                return True
        if isinstance(node, ast.Subscript) and mark(node.slice) and environ(node.value):
            return True
    return False


def runtime_tests(root):
    """The tests/test_*.py modules under `root` that boot the runtime (they read HIVE_TEST_PETTA), sorted."""
    return sorted(str(p.relative_to(root)) for p in Path(root, "tests").glob("test_*.py")
                  if reads_mark(p.read_text(encoding="utf-8", errors="replace")))


def test_imports(root, modules):
    """The tests/ modules that `modules` (paths under `root`) import, directly or through each other, by the names
    the tests use: test_channel_hive (tests/ on sys.path) or tests.test_channel_hive. A runtime test that takes its
    fake hub from tests/test_channel_hive.py runs on that file too."""
    found, todo = set(), list(modules)
    while todo:
        source = Path(root, todo.pop()).read_text(encoding="utf-8", errors="replace")
        try:
            tree = ast.parse(source)
        except SyntaxError:
            continue
        names = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
        names += [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module and not n.level]
        for name in names:
            local = name[len("tests."):] if name.startswith("tests.") else name
            path = "tests/" + local.replace(".", "/") + ".py"
            if path not in found and path not in modules and Path(root, path).is_file():
                found.add(path)
                todo.append(path)
    return found


def touches_runtime(paths, tests):
    """Whether any changed path is one of `tests` (the runtime tests and the tests/ modules they import) or matches
    RUNTIME."""
    return any(path in tests or any(fnmatch.fnmatchcase(path, pattern) for pattern in RUNTIME) for path in paths)


def changed(base, head, root):
    """The paths `git diff` reports between `base` and `head`, deleted ones left out (renames give the new path)."""
    out = subprocess.run(
        ["git", "-C", str(root), "diff", "--name-only", "--no-renames", "--diff-filter=d", base, head, "--"],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line for line in out.splitlines() if line]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--runtime", action="store_true", help="print the runtime tests if the PR touches them")
    parser.add_argument("--all", action="store_true", help="with --runtime: print them all, whatever changed")
    parser.add_argument("base", nargs="?", default="HEAD^1", help="the base branch's tip (default HEAD^1)")
    parser.add_argument("head", nargs="?", default="HEAD", help="the merged pull request (default HEAD)")
    args = parser.parse_args(argv)
    root = Path.cwd()
    if args.all:
        if not args.runtime:
            parser.error("--all goes with --runtime")
        print("\n".join(runtime_tests(root)))
        return 0
    try:
        paths = changed(args.base, args.head, root)
    except subprocess.CalledProcessError as error:
        print(f"git diff {args.base} {args.head} failed: {error.stderr.strip()}", file=sys.stderr)
        return 2
    if args.runtime:
        tests = runtime_tests(root)
        chosen = tests if touches_runtime(paths, set(tests) | test_imports(root, tests)) else []
    else:
        chosen = select(paths, lambda p: (root / p).is_file())
    for path in chosen:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
