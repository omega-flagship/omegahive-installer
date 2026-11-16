"""Purpose: verify hive command signatures preserve documents and parse task history and continuation arguments.

Hive commands that carry a document or JSON keep its exact text (Jon 11-09).

hive-goal-propose was rest-text, so a mind's multi-line result (a Python acceptance check for Create) was collapsed
onto one line and could not even be parsed: every check run exited 1 with no output. Results, reviews, revisions,
artifacts and flow drafts are now `multiline`; titles, reasons and filters still collapse to one line."""
import json
import pathlib
import sys
import unittest

from hive.spaces.sexpr import parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import helper_command_parser as parser  # noqa: E402
from test_code_signatures_exact_text import _args  # noqa: E402

SIGNATURES = ROOT / "modules" / "hive" / "signatures.metta"
KEEP = ["hive-goal-done", "hive-goal-propose", "hive-review-complete", "hive-revision", "hive-revision-part",
        "hive-artifact-create", "hive-flow-draft", "hive-flow-revise"]


class HiveSignatureExactTextTest(unittest.TestCase):
    def setUp(self):
        parser.reload_signature_commands(SIGNATURES)

    def tearDown(self):
        parser.reload_signature_commands()

    def test_document_arguments_are_multiline(self):
        for name in KEEP:
            self.assertEqual(parser.SIGNATURE_COMMANDS[name][-1][0], "multiline", name)
        self.assertEqual(parser.SIGNATURE_COMMANDS["hive-goal-create"][-1][0], "rest-text")

    def test_a_proposed_python_file_keeps_its_lines(self):
        check = "import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertTrue(True)\n"
        payload = json.dumps({"files": {"checks/acceptance_check.py": check}})
        _, args = _args(parser.signature_balance_parentheses("hive-goal-propose g_1 " + payload))
        self.assertEqual(args[0], "g_1")
        self.assertEqual(json.loads(args[1])["files"]["checks/acceptance_check.py"], check)

    def test_a_title_still_collapses(self):
        _, args = _args(parser.signature_balance_parentheses("hive-goal-create g_1 two\nlines"))
        self.assertEqual(args, ["g_1", "two lines"])

    def test_history_and_output_offsets_and_continuation_instructions_parse(self):
        examples = [("hive-goal-history \"tip calculator\" 3", "hive-goal-history", ["tip calculator", 3]),
                    ("hive-goal-output g_1 3000", "hive-goal-output", ["g_1", 3000]),
                    ("hive-goal-continue g_1 finish the chart", "hive-goal-continue", ["g_1", "finish the chart"])]
        for command, expected_head, expected_args in examples:
            head, *args = parse(parser.signature_balance_parentheses(command))[0]
            self.assertEqual((head, args), (expected_head, expected_args))


if __name__ == "__main__":
    unittest.main()
