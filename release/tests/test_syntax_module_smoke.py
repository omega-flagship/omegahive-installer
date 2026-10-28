#!/usr/bin/env python3
"""Syntax smoke tests for optional module-provided command signatures."""

import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
import helper  # noqa: E402
from module_loader_test_utils import enabled_module_loader  # noqa: E402


class ModuleSyntaxSmokeTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(helper.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def assert_parse(self, raw, expected):
        actual = helper.signature_balance_parentheses(raw)
        self.assertEqual(actual, expected)
        self.assert_metta_ok(actual)

    def test_module_rest_text_signatures_accept_natural_language_tasks(self):
        cases = {
            "codex-code-readonly list the files in the current directory and briefly describe what this repo does":
                '((codex-code-readonly "list the files in the current directory and briefly describe what this repo does"))',
            "codex-code fix the parser test and explain residual risk":
                '((codex-code "fix the parser test and explain residual risk"))',
            "codex-code-readonly-start inspect the scratch space without blocking the loop":
                '((codex-code-readonly-start "inspect the scratch space without blocking the loop"))',
            "codex-code-start add a small test and report residual risk":
                '((codex-code-start "add a small test and report residual risk"))',
        }
        with enabled_module_loader(helper, "codex_code"):
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    self.assert_parse(raw, expected)

    def test_code_evidence_commands_have_native_signatures(self):
        cases = {
            'code-create src/new.metta (x "a;b")': r'((code-create "src/new.metta" "(x \"a;b\")"))',
            "code-move old.metta new.metta": '((code-move "old.metta" "new.metta"))',
            "code-remove old.metta": '((code-remove "old.metta"))',
            "code-runs -": '((code-runs "-"))',
            "code-verifications opaque": '((code-verifications "opaque"))',
            "code-output run_one 1024": '((code-output "run_one" "1024"))',
            "code-diagnostics src/example.metta": '((code-diagnostics "src/example.metta"))',
        }
        with enabled_module_loader(helper, "code"):
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    self.assert_parse(raw, expected)

    def test_code_review_commands_have_native_signatures(self):
        cases = {
            'code-merge-preview cp_base cp_incoming': '((code-merge-preview "cp_base" "cp_incoming"))',
            'code-merge-files merge_one 0': '((code-merge-files "merge_one" "0"))',
            'code-merge-bytes merge_one file.py merged 0': '((code-merge-bytes "merge_one" "file.py" "merged" "0"))',
            'code-merge-apply merge_one []': '((code-merge-apply "merge_one" "[]"))',
            'code-merge-apply merge_one [{"path":"x","choice":"incoming"}]': r'((code-merge-apply "merge_one" "[{\"path\":\"x\",\"choice\":\"incoming\"}]"))',
            'code-git': '((code-git))',
            'code-git-export review/native Review saved source': '((code-git-export "review/native" "Review saved source"))',
            'code-git-export-state gx_one': '((code-git-export-state "gx_one"))',
            'code-git-patch gx_one 1024': '((code-git-patch "gx_one" "1024"))',
            'code-review base': '((code-review "base"))',
            'code-hunks review_one 5': '((code-hunks "review_one" "5"))',
            'code-hunk-bytes review_one h_one after 0': '((code-hunk-bytes "review_one" "h_one" "after" "0"))',
            'code-select review_one h_a h_b': '((code-select "review_one" "h_a h_b"))',
        }
        with enabled_module_loader(helper, "code"):
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    self.assert_parse(raw, expected)

    def test_scratch_raw_atom_signatures_accept_draft_atoms(self):
        cases = {
            "scratch-status": '((scratch-status))',
            "scratch-add (ScratchDraft reboot-test \"scratch organ available after reboot\")":
                '((scratch-add (ScratchDraft reboot-test "scratch organ available after reboot") 3))',
            "scratch-add (ScratchDraft reboot-test ok) 2":
                "((scratch-add (ScratchDraft reboot-test ok) 2))",
            'scratch-add "(ScratchDraft" "reboot-test" "ok)" "2"':
                "((scratch-add (ScratchDraft reboot-test ok) 2))",
            "scratch-find (ScratchDraft reboot-test $x)":
                "((scratch-find (ScratchDraft reboot-test $x)))",
            'scratch-find "(ScratchDraft" "reboot-test" "$x)"':
                "((scratch-find (ScratchDraft reboot-test $x)))",
            "scratch-promote (ScratchDraft reboot-test ok) verified after smoke":
                '((scratch-promote (ScratchDraft reboot-test ok) "verified after smoke"))',
            'scratch-promote "(ScratchDraft" "reboot-test" "ok)" verified after smoke':
                '((scratch-promote (ScratchDraft reboot-test ok) "verified after smoke"))',
        }
        with enabled_module_loader(helper, "scratch_space"):
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    self.assert_parse(raw, expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
