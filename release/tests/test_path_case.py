#!/usr/bin/env python3
"""Purpose: check that no two tracked paths differ only in letter case under the same parent folder.

macOS and Windows disks don't tell such names apart, so one file shadows the other there while Linux and CI see two.
On 18 Nov main held hive/ui/src/features/programs/ActForm.tsx beside actForm.ts: a Mac resolved './ActForm' to the
.ts file, its UI build failed, and Jon's hive rolled its upgrade back (omega-flagship/omegahive#450). This check reads
every path git tracks, files and every folder above them at any depth, so it covers Python, the UI and the rest alike,
and compares a module file as an import names it, without its extension, since ActForm.tsx and actForm.ts differ in
more than case as file names yet both answer './ActForm' on such a disk.
"""

import collections
import pathlib
import re
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
# the extensions an import leaves out: TypeScript and JavaScript resolvers try them in turn, and Python imports a
# module by its stem
MODULE = re.compile(r"\.(tsx|ts|jsx|js|mjs|cjs|py)$")


def tracked_paths():
    """Every file git tracks under the repository root, as a relative POSIX path."""
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def case_clashes(paths):
    """{(parent folder, name lowered): the distinct names there} for every parent holding two names that differ only
    in case, files and folders alike. Time: one pass over each path's parts, so total path length."""
    names = collections.defaultdict(set)
    for path in paths:
        parts = path.split("/")
        for depth, name in enumerate(parts):
            parent = "/".join(parts[:depth])
            names[(parent, name.lower())].add(name)
            last = depth == len(parts) - 1
            if not last or MODULE.search(name):    # a folder or a module, as an import names it
                stem = MODULE.sub("", name) if last else name
                names[(parent, "import " + stem.lower())].add(stem)
    return {key: sorted(found) for key, found in names.items() if len(found) > 1}


class PathCaseTest(unittest.TestCase):
    def test_no_two_paths_differ_only_in_case(self):
        clashes = case_clashes(tracked_paths())
        self.assertEqual(
            clashes, {},
            "names a case-insensitive disk (macOS, Windows) can't tell apart: "
            + "; ".join(f"{parent or '.'}: {', '.join(found)}" for (parent, _), found in sorted(clashes.items())))

    def test_the_check_finds_a_clash_at_any_depth(self):
        def found(paths):
            return sorted(tuple(names) for names in case_clashes(paths).values())
        self.assertEqual(found(["ui/ActForm.tsx", "ui/actForm.ts"]), [("ActForm", "actForm")])
        self.assertEqual(found(["ui/Button.tsx", "ui/Button.css", "ui/Button.test.tsx"]), [])
        self.assertEqual(found(["ui/act.ts", "ui/Act/index.ts"]), [("Act", "act")])
        self.assertEqual(found(["ui/Form.ts", "ui/form.ts"]), [("Form", "form"), ("Form.ts", "form.ts")])
        self.assertEqual(found(["a/Lib/x.py", "a/lib/y.py"]), [("Lib", "lib"), ("Lib", "lib")])
        self.assertEqual(found(["README.md", "readme.md"]), [("README.md", "readme.md")])

if __name__ == "__main__":
    unittest.main()
