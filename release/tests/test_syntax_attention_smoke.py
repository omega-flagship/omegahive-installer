#!/usr/bin/env python3
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import helper  # noqa: E402


class AttentionSyntaxSmokeTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(helper.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def assert_parse(self, raw, expected):
        actual = helper.signature_balance_parentheses(raw)
        self.assertEqual(actual, expected)
        self.assert_metta_ok(actual)

    def test_attention_examples(self):
        cases = {
            "attention-status": "((attention-status))",
            "attention-scan-persistent 20": "((attention-scan-persistent 20))",
            "attention-review abc123": '((attention-review "abc123"))',
            "attention-rent abc123 0.3 stale practice": '((attention-rent "abc123" 0.3 "stale practice"))',
            "ecan-pass persistent cautious 3": '((ecan-pass "persistent" "cautious" 3))',
            "space-find attention (ImmuneProposal $hash $action $why $score)": '((space-find "attention" "(ImmuneProposal $hash $action $why $score)"))',
            "ecan-pass assume review-only 3": '((ecan-pass "assume" "review-only" 3))',
            "ecan-pass attention review-only 3": '((ecan-pass "attention" "review-only" 3))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assert_parse(raw, expected)

    def test_attention_catalog_help(self):
        self.assertIn("ecan-pass", helper.skill_help("attention"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
